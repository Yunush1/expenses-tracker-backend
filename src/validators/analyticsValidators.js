const { z } = require("zod");
const { objectId } = require("./common");

/**
 * The range is optional in shape and effectively required in practice: a request
 * with no `from` is asking for all of history, which only a plan with unbounded
 * depth may have. That is enforced in entitlementService rather than here, because
 * "how far back" is an entitlement question and this file only knows about types.
 */
const categoryBreakdownQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Whose spending — omitted for the whole group. Checked against the group. */
  memberId: objectId.optional(),
});

module.exports = { categoryBreakdownQuery };
