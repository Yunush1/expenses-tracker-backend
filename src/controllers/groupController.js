const asyncHandler = require("../middlewares/asyncHandler");
const groupService = require("../services/groupService");
const { ok, created } = require("../utils/apiResponse");

/** Controllers are thin: parse the request, call one service, shape the response. */

exports.createGroup = asyncHandler(async (req, res) => {
  const result = await groupService.createGroup({
    ...req.body,
    deviceId: req.deviceId,
  });

  return created(res, result, "Group created");
});

exports.lookupByJoinCode = asyncHandler(async (req, res) => {
  const data = await groupService.lookupByJoinCode(req.query.code);
  return ok(res, data);
});

exports.getPreview = asyncHandler(async (req, res) => {
  const data = await groupService.getPreview(req.group, req.member);
  return ok(res, data);
});

exports.getSummary = asyncHandler(async (req, res) => {
  const data = await groupService.getSummary(req.group, req.member);
  return ok(res, data);
});

exports.updateGroup = asyncHandler(async (req, res) => {
  const group = await groupService.updateGroup({
    group: req.group,
    actor: req.member,
    ...req.body,
  });

  return ok(res, { group }, "Group updated");
});

exports.archiveGroup = asyncHandler(async (req, res) => {
  const group = await groupService.archiveGroup({ group: req.group, actor: req.member });
  return ok(res, { group }, "Group archived");
});

exports.deleteGroup = asyncHandler(async (req, res) => {
  await groupService.deleteGroup({ group: req.group, actor: req.member });
  return ok(res, null, "Group deleted");
});
