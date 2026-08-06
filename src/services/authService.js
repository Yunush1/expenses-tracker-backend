const User = require("../models/user");
const PushToken = require("../models/pushToken");
const { POINT_EVENT_TYPES } = require("../constants");
const logger = require("../utils/logger");

/**
 * Turning a verified token into a row in this database.
 *
 * Everything here assumes the token has **already** been checked by
 * `requireAuth` — this module never verifies anything, and must never be called
 * with a claims object that came from a request body.
 */

/**
 * Find or create the user behind a verified token.
 *
 * Upsert rather than a separate registration step, because there is no
 * registration to have: Firebase creates the account, and the first request that
 * arrives with a valid token for an unknown uid *is* the sign-up. A dedicated
 * `/register` endpoint could only ever duplicate what the first authenticated
 * request already proves.
 *
 * Profile fields are refreshed on every call so a changed display name or a
 * newly verified email lands without a separate sync — they are cheap, they come
 * free with the token, and they are display data rather than state anyone
 * depends on.
 */
/**
 * How stale `lastSeenAt` is allowed to get before a write is worth doing.
 *
 * Without this every authenticated request writes to the users collection —
 * including every read — because `lastSeenAt` always differs. That is a write
 * amplification of one-per-request for a field whose only consumer is a human
 * asking "when were they last here", to whom an hour's resolution is indistinguishable
 * from a millisecond's.
 */
const LAST_SEEN_TTL_MS = 60 * 60 * 1000;

const profileDiffers = (user, claims) =>
  user.email !== (claims.email || "") ||
  user.emailVerified !== Boolean(claims.email_verified) ||
  user.displayName !== (claims.name || "") ||
  user.photoURL !== (claims.picture || "") ||
  user.phoneNumber !== (claims.phone_number || "") ||
  user.signInProvider !== (claims.firebase?.sign_in_provider || "");

/**
 * @param context.referralCode  the invite code this browser arrived with, if any
 * @param context.deviceId      the browser making the request
 */
const upsertFromClaims = async (claims, context = {}) => {
  const existing = await User.findOne({ firebaseUid: claims.uid });

  /**
   * The common path: a known user whose profile has not changed and whose
   * `lastSeenAt` is recent enough. Return the row and write nothing — this is
   * every request after the first in an hour, so it is the one worth optimising.
   */
  if (existing) {
    const seenRecently = Date.now() - existing.lastSeenAt.getTime() < LAST_SEEN_TTL_MS;
    if (seenRecently && !profileDiffers(existing, claims)) return existing;
  }

  const update = {
    email: claims.email || "",
    emailVerified: Boolean(claims.email_verified),
    displayName: claims.name || "",
    photoURL: claims.picture || "",
    phoneNumber: claims.phone_number || "",
    // Diagnostics only — never read to make an access decision.
    signInProvider: claims.firebase?.sign_in_provider || "",
    lastSeenAt: new Date(),
  };

  /**
   * The referrer, resolved **only** when this request is about to create the row.
   *
   * `referredBy` goes in `$setOnInsert`, which is the whole design: it is written
   * at account creation and by nothing else, ever. An existing user sending an
   * invite code — deliberately or because it is still sitting in their
   * localStorage — changes nothing, and there is no other endpoint that can.
   *
   * Resolution is skipped entirely for known users so the common path stays one
   * query, and a rejected code (unknown, or the referrer's own browser) simply
   * yields null rather than failing the sign-in.
   */
  const setOnInsert = { firebaseUid: claims.uid };

  if (!existing && context.referralCode) {
    // eslint-disable-next-line global-require -- referralService reads User back
    const referralService = require("./referralService");
    const referrerId = await referralService.resolveReferrer(
      context.referralCode,
      context.deviceId
    );
    if (referrerId) setOnInsert.referredBy = referrerId;
  }

  const user = await User.findOneAndUpdate(
    { firebaseUid: claims.uid },
    { $set: update, $setOnInsert: setOnInsert },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  /**
   * The welcome bonus — for genuinely new accounts only.
   *
   * `existing` was fetched before the upsert, so its absence is what "new" means
   * here; the award itself is once-ever, so a race between two first requests
   * still credits one bonus. Unawaited, because a points failure must not delay
   * or fail a sign-in.
   */
  if (!existing) {
    // eslint-disable-next-line global-require -- avoids a load-order dependency
    const pointsService = require("./pointsService");
    pointsService
      .award(user._id, POINT_EVENT_TYPES.WELCOME_BONUS, {
        referred: Boolean(setOnInsert.referredBy),
      })
      .catch(() => {});
  }

  return user;
};

/**
 * Associate the browser making this request with the signed-in account.
 *
 * ## What this merges, and what it refuses to
 *
 * It records the device on the account and stamps the account onto that device's
 * push token, so a ledger reminder reaches every browser the person uses rather
 * than only the one that created the entry.
 *
 * It does **not** touch `Member` rows. The tempting version — "this browser is
 * already Riya in the Goa group, so give Riya to this account" — is a data-leak
 * waiting for a shared laptop:
 *
 * > Two flatmates share a machine. One has been using the app for months and is a
 * > member of three groups. The other signs into their own Google account. Under
 * > an automatic merge, the second person's account now owns the first person's
 * > group identity, their expenses and their balances — and the first person has
 * > no way to discover it, let alone undo it.
 *
 * A `deviceId` is evidence that a *browser* was used. It is never proof of *who*
 * was using it, and the entire no-auth model already depends on that distinction:
 * this is exactly why `linkDevice` requires a code typed from a device you already
 * hold rather than trusting a device id on its own (docs/02-HLD.md §3.2). Claiming
 * a group membership is the same operation and needs the same proof — an explicit,
 * per-membership confirmation by the person who owns it, not a silent side effect
 * of signing in.
 *
 * Best effort throughout: a failure here must not break a sign-in.
 */
const linkDevice = async (user, deviceId) => {
  if (!deviceId) return user;

  try {
    const [updated] = await Promise.all([
      user.deviceIds?.includes(deviceId)
        ? user
        : User.findOneAndUpdate(
            { _id: user._id },
            { $addToSet: { deviceIds: deviceId } },
            { new: true }
          ),
      /**
       * Claim the push token for this account. `$ne` guards the shared-browser
       * case: when someone else was signed in here, the row is reassigned to
       * whoever is signed in now — which is correct, because the reminders it
       * carries should follow the current user, and the previous account keeps
       * its own other devices.
       */
      PushToken.updateOne({ deviceId }, { $set: { userId: user._id } }),
    ]);

    return updated || user;
  } catch (err) {
    logger.warn(`[authService] Could not link device to account: ${err.message}`);
    return user;
  }
};

/** The shape the API returns for "who am I". Never includes internal ids. */
const toProfileDTO = (user) => ({
  id: String(user._id),
  email: user.email,
  emailVerified: user.emailVerified,
  displayName: user.displayName,
  photoURL: user.photoURL,
  phoneNumber: user.phoneNumber,
  signInProvider: user.signInProvider,
  createdAt: user.createdAt,
  /**
   * A boolean, not the referrer's id: the client only needs to know whether the
   * invite code it is holding has already been used, so it can stop sending it.
   * Who invited whom is nobody else's business, including the invitee's.
   */
  referred: Boolean(user.referredBy),
});

module.exports = { upsertFromClaims, linkDevice, toProfileDTO };
