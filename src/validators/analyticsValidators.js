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

/**
 * What to export, and over what range.
 *
 * No `format`: CSV is the only one, and a parameter offering a choice of one is a
 * promise the endpoint does not keep. When a PDF exists it gets its own route,
 * because it is a document with a layout rather than the same data in another
 * encoding.
 *
 * The range is optional and unbounded by default — the whole history is the point
 * of an export, and unlike analytics this feature is metered rather than depth-
 * limited, so there is nothing to withhold.
 */
const exportQuery = z.object({
  type: z.enum(["expenses", "settlements"]).optional().default("expenses"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

module.exports = { categoryBreakdownQuery, exportQuery };
