const asyncHandler = require("../middlewares/asyncHandler");
const cycleService = require("../services/cycleService");
const { ok, created } = require("../utils/apiResponse");

/** Balance cycles, previous dues and the requests between members — docs/29-BALANCE-CYCLES.md. */

exports.getCycle = asyncHandler(async (req, res) => ok(res, cycleService.getCycle(req.group)));

exports.closeGroup = asyncHandler(async (req, res) => {
  const group = await cycleService.closeGroup({ group: req.group, actor: req.member });
  return ok(res, { group }, "Split closed");
});

exports.reopenGroup = asyncHandler(async (req, res) => {
  const group = await cycleService.reopenGroup({ group: req.group, actor: req.member, endDate: req.body.endDate });
  return ok(res, { group }, "Split reopened");
});

exports.getDues = asyncHandler(async (req, res) => ok(res, await cycleService.getDues(req.group, req.member)));

exports.offsetDues = asyncHandler(async (req, res) => {
  const data = await cycleService.offsetDues({ group: req.group, actor: req.member, dto: req.body });
  return ok(res, data, "Dues offset");
});

exports.listRequests = asyncHandler(async (req, res) =>
  ok(res, await cycleService.listRequests(req.group, req.member))
);

exports.createRequest = asyncHandler(async (req, res) => {
  const request = await cycleService.createRequest({ group: req.group, actor: req.member, dto: req.body });
  return created(res, { request }, "Request sent");
});

exports.respondToRequest = asyncHandler(async (req, res) => {
  const data = await cycleService.respondToRequest({
    group: req.group,
    actor: req.member,
    requestId: req.params.requestId,
    action: req.body.action,
  });
  return ok(res, data);
});
