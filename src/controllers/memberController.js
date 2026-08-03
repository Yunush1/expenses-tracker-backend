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
