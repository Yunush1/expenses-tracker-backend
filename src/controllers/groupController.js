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
  // The device is passed so a browser already in the group skips the approval
  // dance — see groupService.lookupByJoinCode.
  const data = await groupService.lookupByJoinCode(req.query.code, req.deviceId);
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

/**
 * Undo a delete. Creator only — see `groupService.restoreGroup`.
 *
 * The message says what happened to the short code, because that is the one part
 * of a restore that can silently come back different: it is released on delete so
 * somebody else can use it, and by now somebody may have.
 */
exports.restoreGroup = asyncHandler(async (req, res) => {
  const payload = await groupService.restoreGroup({ group: req.group, actor: req.member });

  const message = payload.joinCodeLost
    ? `Group restored. The code ${payload.joinCodeLost} was taken while it was deleted, so the group has none — share the invite link, or set a new code.`
    : "Group restored";

  return ok(res, payload, message);
});
