const asyncHandler = require("../middlewares/asyncHandler");
const memberService = require("../services/memberService");
const { ok, created } = require("../utils/apiResponse");

exports.listMembers = asyncHandler(async (req, res) => {
  const members = await memberService.listMembers(req.group, req.member);
  return ok(res, { members });
});

exports.joinGroup = asyncHandler(async (req, res) => {
  const { member, created: isNew } = await memberService.joinGroup({
    group: req.group,
    name: req.body.name,
    deviceId: req.deviceId,
  });

  // 200 rather than 201 when this device had already joined — the call is
  // idempotent, and reporting "created" for a no-op would be a lie.
  return isNew
    ? created(res, { member }, "Joined group")
    : ok(res, { member }, "Already a member");
});

exports.claimMember = asyncHandler(async (req, res) => {
  const member = await memberService.claimMember({
    group: req.group,
    memberId: req.body.memberId,
    deviceId: req.deviceId,
  });

  return ok(res, { member }, "Identity claimed");
});

exports.createDeviceLinkCode = asyncHandler(async (req, res) => {
  const payload = await memberService.createDeviceLinkCode({
    group: req.group,
    actor: req.member,
  });

  return created(res, payload, "Link code created");
});

exports.linkDevice = asyncHandler(async (req, res) => {
  const payload = await memberService.linkDevice({
    group: req.group,
    deviceId: req.deviceId,
    code: req.body.code,
  });

  return ok(res, payload, "Device linked");
});

exports.mergeMembers = asyncHandler(async (req, res) => {
  const payload = await memberService.mergeMembers({
    group: req.group,
    actor: req.member,
    sourceId: req.params.memberId,
    targetId: req.body.intoMemberId,
  });

  return ok(res, payload, "Members merged");
});

exports.addMember = asyncHandler(async (req, res) => {
  const member = await memberService.addMember({
    group: req.group,
    actor: req.member,
    name: req.body.name,
  });

  return created(res, { member }, "Member added");
});

exports.renameMember = asyncHandler(async (req, res) => {
  const member = await memberService.renameMember({
    group: req.group,
    actor: req.member,
    memberId: req.params.memberId,
    name: req.body.name,
  });

  return ok(res, { member }, "Member renamed");
});

exports.removeMember = asyncHandler(async (req, res) => {
  await memberService.removeMember({
    group: req.group,
    actor: req.member,
    memberId: req.params.memberId,
  });

  return ok(res, null, "Member removed");
});
