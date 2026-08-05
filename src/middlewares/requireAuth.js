const { getAuth, isAuthEnabled } = require("../config/firebase");
const { getRedis, isRedisReady } = require("../config/redis");
const authService = require("../services/authService");
const { UnauthorizedError, ServiceUnavailableError } = require("../errors");
const { ERROR_CODES } = require("../constants");
const logger = require("../utils/logger");

/**
 * The one place a signed-in identity is established (docs/09-AUTH.md §4).
 *
 * This is the sibling of `resolveMember`, not a replacement for it. Group routes
 * keep resolving identity from `X-Device-Id` and never reach this file; only the
 * personal ledger is mounted behind it. That separation is the whole scoping
 * argument in docs/09-AUTH.md §1, and it is why this middleware is applied at the
 * router rather than globally — a global `app.use` here would silently put a
 * login in front of the product's central promise.
 *
 * ## What is trusted
 *
 * The decoded token, and nothing else. `uid` comes from the verified claims; a
 * `userId` in a body or query is a suggestion from an untrusted party and is
 * never read. Verification is a local signature check against Google's cached
 * signing keys, so this costs no network round trip per request.
 */

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * How long a revocation check is trusted before it is repeated.
 *
 * `verifyIdToken(token, true)` is **not** a local operation: measured at ~335ms
 * against ~0.3ms for signature-only verification, because the revocation check
 * fetches the user record from Firebase. Paying that on every request would add
 * a third of a second to every read of the ledger — for a check whose answer
 * changes maybe once in an account's lifetime.
 *
 * So the signature is verified locally on every request, and revocation is
 * re-checked at most once per uid per window. The honest cost: a revoked session
 * can survive up to this long. Weighed against a token's one-hour natural life,
 * that turns "up to 60 minutes of exposure" into "up to 5" while removing the
 * latency from 99% of requests.
 */
const REVOCATION_TTL_MS = 5 * 60 * 1000;
/** Bounded so a stream of distinct uids cannot grow this without limit. */
const REVOCATION_CACHE_MAX = 5000;

const revocationCheckedAt = new Map();

const redisKey = (uid) => `auth:revcheck:${uid}`;

/**
 * Shared across processes when Redis is available, per-process otherwise.
 *
 * Without sharing, every instance re-pays the ~335ms Firebase lookup on its own
 * schedule — so the cost scales with instance count rather than with users. A
 * Redis failure degrades to the in-memory map, which is the behaviour before
 * Redis existed and is perfectly correct, just less efficient.
 */
const revocationCheckDue = async (uid) => {
  if (isRedisReady()) {
    try {
      return !(await getRedis().get(redisKey(uid)));
    } catch {
      /* fall through to the in-memory map */
    }
  }

  const checkedAt = revocationCheckedAt.get(uid);
  return !checkedAt || Date.now() - checkedAt > REVOCATION_TTL_MS;
};

const markRevocationChecked = async (uid) => {
  if (isRedisReady()) {
    try {
      // Redis expires it for us — no eviction policy to maintain.
      await getRedis().set(redisKey(uid), "1", "PX", REVOCATION_TTL_MS);
      return;
    } catch {
      /* fall through */
    }
  }

  // Cheapest possible eviction: on overflow, drop the oldest insertions. Map
  // preserves insertion order, so the first keys are the least recently added.
  if (revocationCheckedAt.size >= REVOCATION_CACHE_MAX) {
    for (const key of revocationCheckedAt.keys()) {
      revocationCheckedAt.delete(key);
      if (revocationCheckedAt.size < REVOCATION_CACHE_MAX * 0.9) break;
    }
  }
  revocationCheckedAt.set(uid, Date.now());
};

/** Called on revocation so the next request re-checks immediately, everywhere. */
const forgetRevocationCheck = async (uid) => {
  revocationCheckedAt.delete(uid);
  if (isRedisReady()) {
    try {
      await getRedis().del(redisKey(uid));
    } catch {
      /* the TTL will clear it soon enough */
    }
  }
};

const extractToken = (req) => {
  const header = req.get("Authorization") || "";
  const match = BEARER.exec(header.trim());
  return match ? match[1].trim() : null;
};

/**
 * Firebase's error codes, mapped to what the client should *do*.
 *
 * The distinction that matters is expiry versus everything else: an ID token
 * lasts an hour, so expiry is a routine event in any session longer than that,
 * and the correct client response is to refresh silently and retry rather than to
 * throw the user back to a sign-in screen they did not ask for.
 */
const classify = (error) => {
  switch (error?.code) {
    case "auth/id-token-expired":
      return { message: "Your session expired — signing you back in", code: ERROR_CODES.TOKEN_EXPIRED };
    case "auth/id-token-revoked":
    case "auth/session-cookie-revoked":
      return { message: "This session was signed out. Sign in again.", code: ERROR_CODES.UNAUTHENTICATED };
    case "auth/user-disabled":
      return { message: "This account has been disabled.", code: ERROR_CODES.ACCOUNT_DISABLED };
    default:
      return { message: "Sign in to continue", code: ERROR_CODES.UNAUTHENTICATED };
  }
};

const requireAuth = async (req, res, next) => {
  try {
    /**
     * Fail closed, and say why. With no Firebase credentials nothing can verify a
     * token, so serving these routes would mean serving them unauthenticated —
     * the one outcome worse than not serving them. 503 rather than 500 because
     * nothing has broken: an operator needs to set credentials.
     */
    if (!isAuthEnabled()) {
      throw new ServiceUnavailableError(
        "Accounts are not configured on this server, so the personal ledger is unavailable. Groups are unaffected."
      );
    }

    const token = extractToken(req);
    if (!token) throw new UnauthorizedError();

    let claims;
    try {
      // Signature, expiry, audience and issuer — local, sub-millisecond.
      claims = await getAuth().verifyIdToken(token);

      /**
       * Revocation, at most once per uid per window (see REVOCATION_TTL_MS).
       *
       * A second verification rather than a flag on the first, because the check
       * is only worth its ~335ms when it is actually due — and this way the
       * expensive path is visibly the exception.
       *
       * Testing note: the comparison is `auth_time < tokensValidAfterTime` and
       * both truncate to whole seconds, so a token revoked in the same second it
       * was issued is still accepted — correctly; the boundary can land just
       * before the token it was meant to kill. Leave a few seconds between
       * sign-in and revoke, or this looks broken when it is not.
       */
      if (await revocationCheckDue(claims.uid)) {
        await getAuth().verifyIdToken(token, true);
        await markRevocationChecked(claims.uid);
      }
    } catch (error) {
      const { message, code } = classify(error);
      // A revoked session must not keep a cached pass from before it was revoked.
      if (error?.code === "auth/id-token-revoked") {
        await forgetRevocationCheck(claims?.uid || error.uid).catch(() => {});
      }
      throw new UnauthorizedError(message, code);
    }

    /**
     * Past this point the caller is authenticated. A failure here is the database,
     * not the credential — so it is rethrown as-is and becomes a 500. Returning
     * 401 for a Mongo outage would tell a signed-in user to sign in again, which
     * they would do, successfully, and land on the same error: an infinite loop
     * that also hides the real fault from whoever is on call.
     */
    req.user = await authService.upsertFromClaims(claims);

    /**
     * `deviceContext` has already run globally, so `req.deviceId` is available
     * here when the browser sent one. Associating it lets ledger reminders reach
     * every browser this account uses — and explicitly does not transfer any
     * group membership; see authService.linkDevice for why that would be unsafe.
     */
    if (req.deviceId) req.user = await authService.linkDevice(req.user, req.deviceId);

    req.firebaseClaims = claims;

    return next();
  } catch (error) {
    if (error?.isOperational) return next(error);

    // Genuinely unexpected — surface it as a 500 rather than dressing it up as
    // an auth failure, and log it, because it should not happen.
    logger.error(`[requireAuth] Unexpected failure: ${error.stack || error.message}`);
    return next(error);
  }
};

module.exports = requireAuth;
module.exports.forgetRevocationCheck = forgetRevocationCheck;
module.exports.REVOCATION_TTL_MS = REVOCATION_TTL_MS;
