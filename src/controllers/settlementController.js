const asyncHandler = require("../middlewares/asyncHandler");
const settlementService = require("../services/settlementService");
const { ok, created } = require("../utils/apiResponse");

exports.getSuggestions = asyncHandler(async (req, res) => {
  const data = await settlementService.getSuggestions(req.group, req.member);
  return ok(res, data);
});

exports.listSettlements = asyncHandler(async (req, res) => {
  const { cursor, limit } = req.validatedQuery;
  const data = await settlementService.listSettlements(req.group, { cursor, limit });
  return ok(res, data);
});

exports.recordSettlement = asyncHandler(async (req, res) => {
  const { settlement, created: isNew } = await settlementService.recordSettlement({
    group: req.group,
    actor: req.member,
    dto: req.body,
  });

  return isNew
    ? created(res, { settlement }, "Settlement recorded")
    : ok(res, { settlement }, "Settlement already recorded");
});
