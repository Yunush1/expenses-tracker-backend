const config = require("../config/env");
const { ForbiddenError } = require("../errors");

/**
 * Operator-only routes — currently just the AI spend figures.
 *
 * Runs *after* `requireAuth`, never instead of it: this decides what an already
 * verified identity is allowed to see, and has no way to establish one itself.
 *
 * ## Why the check is here and not in the browser
 *
 * The obvious version of this feature is an email comparison in the frontend, and
 * it is not access control — the comparison ships in the JavaScript bundle, and the
 * endpoint would still answer anyone who called it with a valid token of their own.
 * Putting it in middleware means the browser's copy of the rule is a *convenience*
 * (don't render a card that will 403) rather than the thing standing between an
 * ordinary account and the operational numbers.
 *
 * ## Why the email, given the User model says not to key on it
 *
 * `models/user.js` is explicit that `email` is not stable and must never be a
 * lookup key, and that is right — for owning rows. This is not a lookup: it is a
 * coarse "is this one of the operators" test, where an operator changing their own
 * email address and updating an env var is an acceptable and visible cost. The
 * alternative, a `firebaseUid` allowlist, is unreadable in a config file and would
 * have to be looked up in the database to write down.
 *
 * Fails closed twice over: an empty `ADMIN_EMAILS` forbids everyone, and an account
 * whose token carries no email is refused rather than waved through.
 */
const requireAdmin = (req, res, next) => {
  const { adminEmails } = config;

  // Nobody configured means nobody is an admin. The feature is simply off, which
  // is the correct posture for a deployment that never asked for it.
  if (adminEmails.length === 0) {
    return next(new ForbiddenError("Not allowed"));
  }

  /**
   * The stored email, falling back to the verified claim.
   *
   * The claim is the more authoritative of the two — it came from the token — but
   * the stored value is the one that is lowercased and trimmed by the schema, so it
   * is tried first and the claim is normalised here to match.
   */
  const email = (req.user?.email || req.firebaseClaims?.email || "").trim().toLowerCase();

  if (!email || !adminEmails.includes(email)) {
    /**
     * 403 with the same wording whoever asks.
     *
     * Deliberately not "you are not an admin" or anything that confirms the route
     * exists and does something interesting. An ordinary account probing this
     * learns only that it cannot have it.
     */
    return next(new ForbiddenError("Not allowed"));
  }

  return next();
};

module.exports = requireAdmin;
