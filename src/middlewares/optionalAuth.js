const requireAuth = require("./requireAuth");
const logger = require("../utils/logger");

/**
 * Attach `req.user` when the caller happens to be signed in, and never fail.
 *
 * Group routes resolve identity from `X-Device-Id` and must keep working with no
 * account at all — that is the product's central promise (docs/09-AUTH.md §1).
 * But a few of them can do something *extra* for a caller who is signed in:
 * redeeming a device link code can bind the member to the account at the same
 * time (docs/17-MEMBER-IDENTITY.md §6.2), which saves a second trip through the
 * same flow.
 *
 * ## An invalid token is "not signed in", not an error
 *
 * This is the load-bearing difference from `requireAuth`. If a stale or expired
 * token returned 401 here, a browser holding one would be unable to use a group
 * — and groups must work whether or not anyone has ever logged in. So a bad
 * token is treated exactly like no token: the request proceeds anonymously and
 * the optional extra simply does not happen.
 *
 * Which makes the response's job explicit: any route using this must report what
 * it actually did, so a client can tell "linked your account" from "linked this
 * device only". Silence would let someone believe they linked an account when
 * their token had quietly expired.
 */
const optionalAuth = async (req, res, next) => {
  if (!req.get("Authorization")) return next();

  try {
    await new Promise((resolve, reject) => {
      requireAuth(req, res, (error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    // Debug, not warn: an expired token on a group route is routine — tokens
    // last an hour and group tabs stay open far longer than that.
    logger.debug?.(`[optionalAuth] Continuing anonymously: ${error.message}`);
    req.user = null;
  }

  return next();
};

module.exports = optionalAuth;
