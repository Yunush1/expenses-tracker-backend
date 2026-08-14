const asyncHandler = require("../middlewares/asyncHandler");
const analyticsService = require("../services/analyticsService");
const { ok } = require("../utils/apiResponse");

/**
 * Spending breakdowns (docs/16-TODO.md §2.3).
 *
 * Readable by anyone holding the link, like every other group read — the plan
 * gates how far *back* it reaches, never whether a member may look at their own
 * group's spending. The depth check lives in the service, because it has to run
 * before the query rather than after it.
 */

exports.getCategoryBreakdown = asyncHandler(async (req, res) => {
  const data = await analyticsService.categoryBreakdown(req.group, req.validatedQuery);
  return ok(res, data);
});
