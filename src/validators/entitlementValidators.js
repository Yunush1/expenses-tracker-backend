const { z } = require("zod");
const config = require("../config/env");
const { PLANS, PLAN_STATUS, GRANT_SOURCES, STORED_PLAN_STATUS } = require("../constants");

/**
 * Shape only. Whether a plan may be granted, and how the days compose with what a
 * group already has, is decided in entitlementService — so this file cannot drift
 * away from the rule that a grant *extends* rather than replaces.
 */

/** FREE is absent on purpose: it is what a group has when nothing is granted. */
const grantablePlan = z.enum([PLANS.GROUP_PRO, PLANS.TRIP_PASS]);

/**
 * Both schemas default the whole object, not just its fields.
 *
 * These are operator endpoints driven from a terminal, and a `curl -X POST` with
 * no body at all is the commonest way to say "give this group the default grant".
 * Express 5 leaves `req.body` undefined when nothing was sent, which a bare
 * `z.object` rejects — so the sensible request would fail validation for having
 * omitted nothing in particular.
 */
const grantEntitlementSchema = z
  .object({
    plan: grantablePlan.optional().default(PLANS.GROUP_PRO),
    /**
     * How long, in days. `null` is meaningful and must survive validation: it
     * means open-ended, which only an operator can ask for and which no purchase
     * will ever produce.
     *
     * The ceiling is checked in the service against the configured maximum as
     * well as here, because "how long may a grant run" is an operator setting and
     * a grant made any other way — a referral payout, a promo — never passes
     * through this file.
     */
    days: z
      .union([z.coerce.number().int().min(1).max(config.entitlement.maxGrantDays), z.null()])
      .optional()
      .default(config.entitlement.defaultGrantDays),
    status: z.enum(STORED_PLAN_STATUS).optional().default(PLAN_STATUS.ACTIVE),
    source: z.enum(Object.values(GRANT_SOURCES)).optional().default(GRANT_SOURCES.ADMIN),
    /** Why. Read by a human months later, so it is worth asking for. */
    note: z.string().trim().max(500).optional().default(""),
  })
  .default({});

const revokeEntitlementSchema = z
  .object({
    note: z.string().trim().max(500).optional().default(""),
  })
  .default({});

module.exports = { grantEntitlementSchema, revokeEntitlementSchema };
