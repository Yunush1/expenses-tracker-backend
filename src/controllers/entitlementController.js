const asyncHandler = require("../middlewares/asyncHandler");
const entitlementService = require("../services/entitlementService");
const { toEntitlementDTO } = require("../serializers");
const { ok } = require("../utils/apiResponse");

/**
 * Issuing and ending plans by hand (docs/22-MONETIZATION.md §10, §14).
 *
 * There is no checkout behind these, and that is the point of building them first:
 * grants issued by hand let real groups use paid features before a payment
 * provider exists, which is how you find out whether anybody wants them. Payments
 * bring tax, invoices, refunds, chargebacks, failed renewals and a support
 * obligation with a response time — all of it worth doing *after* the answer.
 *
 * Operator-only, enforced by `requireAdmin` in the route rather than here.
 *
 * There is deliberately no read endpoint. A group's plan is on its summary
 * payload, where every screen already reads it from.
 */

exports.grant = asyncHandler(async (req, res) => {
  const entitlement = await entitlementService.grant({
    group: req.group,
    ...req.body,
    /**
     * Recorded from the verified token, never from the body. The audit trail for a
     * hand grant is only worth having if it says who actually made it.
     */
    grantedByEmail: req.user?.email || req.firebaseClaims?.email || null,
  });

  return ok(res, { entitlement: toEntitlementDTO(entitlement) }, "Plan granted");
});

exports.revoke = asyncHandler(async (req, res) => {
  const entitlement = await entitlementService.revoke(req.group, req.body);

  return ok(res, { entitlement: toEntitlementDTO(entitlement) }, "Plan ended");
});
