const entitlementService = require("../services/entitlementService");
const asyncHandler = require("./asyncHandler");

/**
 * Gate a route on the group's plan (docs/22-MONETIZATION.md §6).
 *
 * Runs after `loadGroup`, and reads the entitlement from the group — never from
 * the device, the member or the caller's account. That is not a stylistic choice:
 * a group is reachable by an invite link with no account at all, so "is this
 * device premium" is a question with no safe answer, and writing the check that
 * way would mean a copied `localStorage` value was a licence.
 *
 * ## Why the check is here as well as in the browser
 *
 * It is not "as well as" — this is the check. The `features` block on the group
 * payload exists so the UI can draw a lock instead of a button, which is a
 * courtesy to the person using the app and no obstacle whatsoever to anyone
 * calling the endpoint directly. §6 puts it plainly: every gated action re-checks
 * server-side at the point of use.
 *
 * ## Metered features need `consume`, not this
 *
 * This answers "may they?", which for a metered feature means "is there any
 * allowance left" — and then leaves it unclaimed. Two simultaneous requests both
 * pass. A route that spends money per call must take its use through
 * `entitlementService.consume`, which checks and claims atomically. Using this
 * guard alone in front of a paid provider call is the bug it cannot prevent.
 *
 * The resolved snapshot is left on `req.entitlement` so the handler does not read
 * it a second time.
 */
const requireFeature = (feature) =>
  asyncHandler(async (req, res, next) => {
    const snapshot = await entitlementService.forGroup(req.group._id);

    entitlementService.assertAllowed(snapshot, feature, req.group);

    req.entitlement = snapshot;
    return next();
  });

module.exports = requireFeature;
