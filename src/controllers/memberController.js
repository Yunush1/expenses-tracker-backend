const asyncHandler = require("../middlewares/asyncHandler");
const memberService = require("../services/memberService");
const joinRequestService = require("../services/joinRequestService");
const { ok, created, accepted } = require("../utils/apiResponse");

exports.listMembers = asyncHandler(async (req, res) => {
  const members = await memberService.listMembers(req.group, req.member);
  return ok(res, { members });
});

exports.joinGroup = asyncHandler(async (req, res) => {
  /**
   * A private group admits nobody without a member saying yes — including
   * somebody holding the invite link.
   *
   * Gating the link is the whole reason the switch exists: a link forwarded into
   * the wrong chat is the situation people reach for it to fix, and stopping only
   * the typed code would leave the bigger hole open. Already-a-member on this
   * device falls through to the normal path inside `request`, so re-opening the
   * app never asks permission (docs/13-JOIN-APPROVAL.md §2).
   */
  if (req.group.isPrivate && !req.member) {
    const pending = await joinRequestService.request({
      group: req.group,
      name: req.body.name,
      deviceId: req.deviceId,
      userAgent: req.get("User-Agent") || "",
    });

    // Already in on this browser — `request` hands the code straight back.
    if (!pending.alreadyMember) {
      return accepted(res, pending, "Waiting for a member to let you in");
    }
  }

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
    // Present only when this browser is signed in — the route takes optionalAuth,
    // so an anonymous redemption still links the device and nothing more.
    userId: req.user?._id || null,
  });

  return ok(
    res,
    payload,
    payload.accountLinked ? "Device and account linked" : "Device linked"
  );
});

exports.accountLinkStatus = asyncHandler(async (req, res) => {
  const payload = await memberService.accountLinkStatus({
    group: req.group,
    actor: req.member,
    userId: req.user?._id || null,
  });

  return ok(res, payload);
});

exports.linkAccount = asyncHandler(async (req, res) => {
  const payload = await memberService.linkAccount({
    group: req.group,
    member: req.member,
    userId: req.user._id,
  });

  return ok(res, payload, "Account linked");
});

exports.unlinkAccount = asyncHandler(async (req, res) => {
  const payload = await memberService.unlinkAccount({
    group: req.group,
    member: req.member,
    userId: req.user._id,
  });

  return ok(res, payload, "Account unlinked");
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
