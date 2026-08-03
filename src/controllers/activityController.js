const asyncHandler = require("../middlewares/asyncHandler");
const activityService = require("../services/activityService");
const { ok } = require("../utils/apiResponse");

exports.listActivities = asyncHandler(async (req, res) => {
  const { cursor, limit, type } = req.validatedQuery;
  const data = await activityService.list(req.group._id, { cursor, limit, type });
  return ok(res, data);
});
