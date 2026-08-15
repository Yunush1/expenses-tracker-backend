const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/user");
const PointEvent = require("../models/pointEvent");
const pointsService = require("./pointsService");
const referralRewardService = require("./referralRewardService");
const config = require("../config/env");
const { POINT_EVENT_TYPES, REFERRAL_LEVEL_TYPES } = require("../constants");
const logger = require("../utils/logger");

/**
 * Invite links, and the multi-level rewards behind them (docs/12-REFERRALS.md).
 *
 * ## The threat this file is mostly about
 *
 * Points buy AI questions. AI questions cost the operator real money. So a
 * referral scheme here is not a vanity metric that inflates harmlessly when
 * abused — it converts fake accounts directly into someone else's API bill, and
 * a multi-level one multiplies the payout per fake account by the depth.
 *
 * Four guards follow from that, and none of them is optional:
 *
 * 1. **Activity, not signup, pays.** The upline is credited when the invited
 *    person first logs something real (`referralQualifiedAt`), never when they
 *    create an account. Creating accounts is free and scriptable; using an
 *    expense app for a day is neither. This single rule removes most of the
 *    incentive, because it makes the fraud more expensive than the reward.
 * 2. **A browser cannot invite itself.** If the referrer has ever signed in on
 *    the device making the request, the link is refused — that is the
 *    second-account-on-my-own-laptop case, which is what almost everyone tries
 *    first.
 * 3. **`referredBy` is written once, at account creation, and never updated.**
 *    There is no claim endpoint. Anything that could retro-attach existing users
 *    to a downline would be the single most valuable thing in the system to
 *    abuse.
 * 4. **Every payout is bounded**: once per invited person per level (the dedupe
 *    key), a limited number of people per day (`REFERRAL_DAILY_CAP`), and a
 *    depth ceiling of five whatever the configuration says.
 *
 * ## What this is not
 *
 * Points are a closed in-app currency: they cannot be purchased, transferred,
 * refunded or withdrawn, no part of the product is paywalled behind them, and
 * nobody pays anything to take part. What is configurable here is the depth of a
 * *reward*, not a compensation plan — and that distinction is the reason the
 * depth is safe to expose as a setting at all. It stops being true the moment
 * points acquire a cash value.
 */

/**
 * No `0/O`, `1/I/L`. Codes get read off a screen, typed from a photo, and
 * dictated over the phone — the ambiguous pairs are where that fails.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 7;
/** ~31^7 ≈ 2.7e10. Collisions are rare enough that a handful of retries suffices. */
const MAX_CODE_ATTEMPTS = 5;

const randomCode = () => {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
};

const isEnabled = () => config.referral.enabled;

/**
 * This account's code, generated on first request.
 *
 * Lazy because most people never share: assigning at sign-up would mean a unique
 * index entry and a collision retry for every account, to serve the few that
 * open the invite screen.
 */
const ensureCode = async (user) => {
  if (user.referralCode) return user.referralCode;

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = randomCode();
    try {
      // Conditional on the field still being empty, so two concurrent requests
      // from the same account cannot end up with two codes.
      const updated = await User.findOneAndUpdate(
        { _id: user._id, referralCode: null },
        { $set: { referralCode: code } },
        { new: true }
      );

      // Null means someone else won the race and this account already has one.
      if (updated) return updated.referralCode;
      const current = await User.findById(user._id).select("referralCode").lean();
      if (current?.referralCode) return current.referralCode;
    } catch (err) {
      // A duplicate key is a collision with another account — try another code.
      if (err?.code !== 11000) throw err;
    }
  }

  throw new Error("Could not allocate a referral code");
};

const linkFor = (code) => `${config.appBaseUrl}/?ref=${code}`;

/**
 * Resolve an invite code to the account that owns it, for a *new* signup.
 *
 * Returns null — never throws — for every rejection: a bad code, a disabled
 * scheme, or the self-referral case. A failed referral must never be able to
 * block a sign-in, and the person signing up is not the right audience for
 * "that code was invalid" at that moment anyway.
 *
 * @param deviceId  the browser creating the account, for guard 2 above
 */
const resolveReferrer = async (code, deviceId) => {
  try {
    if (!isEnabled()) return null;

    const normalised = String(code || "").trim().toUpperCase();
    if (normalised.length !== CODE_LENGTH) return null;

    const referrer = await User.findOne({ referralCode: normalised })
      .select("_id deviceIds")
      .lean();
    if (!referrer) return null;

    /**
     * The same browser, signing up again. This is the overwhelmingly common
     * attempt — a second Google account on the machine you already use — and the
     * device list is the evidence we already keep for it.
     *
     * It is not airtight: a private window has a fresh device id. It does not
     * need to be, because the qualification rule behind it means the reward still
     * requires actually using the app as that second person for a day.
     */
    if (deviceId && (referrer.deviceIds || []).includes(deviceId)) {
      logger.warn("[referral] Refused a self-referral from a device the referrer uses");
      return null;
    }

    return referrer._id;
  } catch (err) {
    logger.warn(`[referral] Could not resolve code: ${err.message}`);
    return null;
  }
};

/**
 * Walk up from a newly qualified person, paying each level.
 *
 * Called when someone earns their first `ACTIVE_DAY`. Everything is best effort:
 * a referral failure must not fail the expense that triggered it.
 */
const qualify = async (userId) => {
  try {
    if (!isEnabled() || REFERRAL_LEVEL_TYPES.length === 0) return null;

    /**
     * The latch. Matching on `referralQualifiedAt: null` and setting it in one
     * atomic update means exactly one caller can ever proceed past this line for
     * a given account — so a burst of concurrent activity on someone's first day
     * pays their upline once, not five times.
     */
    const qualified = await User.findOneAndUpdate(
      { _id: userId, referredBy: { $ne: null }, referralQualifiedAt: null },
      { $set: { referralQualifiedAt: new Date() } },
      { new: true }
    );

    if (!qualified) return null; // No referrer, or already counted.

    // The invitee's own half, paid at the same moment for the same reason: it is
    // earned by using the app, not by signing up.
    await pointsService.award(qualified._id, POINT_EVENT_TYPES.REFERRAL_JOINED, {
      referrerId: String(qualified.referredBy),
    });

    /**
     * Up the chain, one level at a time.
     *
     * `seen` is not paranoia. `referredBy` is write-once and self-referral is
     * blocked, so a cycle should be impossible — but "should be impossible" and
     * "cannot hang the process" are different claims, and this is a while loop
     * over user-influenced data. The depth ceiling bounds it regardless.
     */
    const seen = new Set([String(qualified._id)]);
    let current = qualified.referredBy;
    const awarded = [];
    /**
     * The direct referrer, kept aside for the plan-days payout below.
     *
     * Level one only, and the loop below is why the distinction is easy to miss:
     * points are divisible and pay the whole upline by percentage, while days are
     * chunky and pay the person who actually made the invite. See
     * referralRewardService.
     */
    const directReferrer = qualified.referredBy;

    for (let level = 0; level < REFERRAL_LEVEL_TYPES.length && current; level += 1) {
      const key = String(current);
      if (seen.has(key)) break;
      seen.add(key);

      const event = await pointsService.award(
        current,
        REFERRAL_LEVEL_TYPES[level],
        { level: level + 1, referredUserId: String(qualified._id) },
        // Keyed on the person who qualified, so this can never pay twice for
        // them — and stays independent of anyone else in the chain.
        { subject: String(qualified._id) }
      );

      if (event) awarded.push({ level: level + 1, userId: key, points: event.points });

      const next = await User.findById(current).select("referredBy").lean();
      current = next?.referredBy || null;
    }

    if (awarded.length > 0) {
      logger.info(`[referral] Qualified user paid ${awarded.length} level(s) of upline`);
    }

    /**
     * The second payout: days of Group Pro on a group the referrer is in
     * (docs/22-MONETIZATION.md §11).
     *
     * Inside the `referralQualifiedAt` latch, which is what makes it exactly-once
     * without a dedupe key of its own — the same guarantee the points award gets
     * from `key: "subject"`, arrived at by a different route.
     *
     * Awaited rather than fired off, so a failure is logged against this
     * qualification rather than surfacing later with no context. It cannot throw:
     * see grantForReferral.
     */
    const planDays = directReferrer
      ? await referralRewardService.grantForReferral(
          await User.findById(directReferrer).select("_id deviceIds").lean(),
          { referredUserId: String(qualified._id) }
        )
      : null;

    return { levels: awarded, planDays };
  } catch (err) {
    logger.warn(`[referral] Qualification failed: ${err.message}`);
    return null;
  }
};

/**
 * What the invite screen shows.
 *
 * Counts are read from the source rather than kept as counters on the user, for
 * the same reason balances are: a number that can drift from the rows it claims
 * to summarise eventually will.
 */
const stats = async (user) => {
  if (!isEnabled()) return { enabled: false };

  const code = await ensureCode(user);

  const [invited, qualified, earnedRow] = await Promise.all([
    User.countDocuments({ referredBy: user._id }),
    User.countDocuments({ referredBy: user._id, referralQualifiedAt: { $ne: null } }),
    PointEvent.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(String(user._id)),
          type: { $in: [...REFERRAL_LEVEL_TYPES] },
        },
      },
      { $group: { _id: "$type", points: { $sum: "$points" }, count: { $sum: 1 } } },
    ]),
  ]);

  const byLevel = REFERRAL_LEVEL_TYPES.map((type, index) => {
    const row = earnedRow.find((entry) => entry._id === type);
    return {
      level: index + 1,
      /** The share of one referral this level takes — the scheme, as configured. */
      percent: config.referral.percents[index],
      /** That share resolved to whole points, which is what actually lands. */
      points: config.referral.levels[index],
      earned: row?.points || 0,
      people: row?.count || 0,
    };
  });

  return {
    enabled: true,
    code,
    link: linkFor(code),
    /** Direct invitees, and how many of them actually started using it. */
    invited,
    qualified,
    /**
     * Stated so the number on screen is never a surprise: someone who sees "3
     * invited, 0 earned" should be able to find out why without asking.
     */
    pointsEarned: byLevel.reduce((sum, level) => sum + level.earned, 0),
    levels: byLevel,
    basePoints: config.referral.basePoints,
    joinBonus: config.referral.joinBonus,
    dailyCap: config.referral.dailyCap,
    /**
     * The second half of a referral: days of Group Pro on one of your groups
     * (docs/22-MONETIZATION.md §11).
     *
     * Both numbers are here because the promise is conditional and the condition
     * has to be visible *before* somebody earns nothing. Days say what is on
     * offer; `planDaysNeedsActiveGroup` says the group has to be one two people
     * are actually using — which is the guard that stops "create a group, invite
     * yourself, collect", and the sentence that answers "my friend joined, where
     * are my days?".
     *
     * Zero days means the payout is switched off, and the UI should say nothing
     * about it rather than promising nothing.
     */
    planDays: referralRewardService.daysPerReferral(),
    planDaysNeedsActiveGroup: true,
  };
};

module.exports = { ensureCode, resolveReferrer, qualify, stats, isEnabled, linkFor, CODE_LENGTH };
