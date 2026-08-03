const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const asyncHandler = require("./asyncHandler");
const { isValidInviteCode } = require("../utils/inviteCode");
const { GROUP_STATUS, ERROR_CODES } = require("../constants");
const { NotFoundError, GoneError, ForbiddenError, ConflictError } = require("../errors");

/**
 * The whole authorisation model lives in these four guards — see docs/02-HLD.md §3.
 * Swapping device-id identity for real accounts later means changing resolveMember
 * and nothing else in the services.
 */

/** :inviteCode → req.group */
const loadGroup = asyncHandler(async (req, res, next) => {
  const { inviteCode } = req.params;

  if (!isValidInviteCode(inviteCode)) {
    throw new NotFoundError("Group not found", ERROR_CODES.GROUP_NOT_FOUND);
  }

  const group = await groupRepository.findByInviteCode(inviteCode);

  if (!group) {
    throw new NotFoundError("Group not found", ERROR_CODES.GROUP_NOT_FOUND);
  }

  if (group.status === GROUP_STATUS.DELETED) {
    throw new GoneError("This group has been deleted", ERROR_CODES.GROUP_DELETED);
  }

  req.group = group;
  return next();
});

/** (group, deviceId) → req.member, or null for a visitor who has not joined. */
const resolveMember = asyncHandler(async (req, res, next) => {
  req.member = req.deviceId ? await memberRepository.findByDevice(req.group._id, req.deviceId) : null;
  return next();
});

const requireMember = (req, res, next) => {
  if (!req.member) {
    return next(
      new ForbiddenError("Join this group before making changes", ERROR_CODES.NOT_A_MEMBER)
    );
  }
  return next();
};

const requireCreator = (req, res, next) => {
  if (!req.member) {
    return next(new ForbiddenError("Join this group first", ERROR_CODES.NOT_A_MEMBER));
  }

  if (!req.member.isCreator) {
    return next(
      new ForbiddenError("Only the group creator can do this", ERROR_CODES.CREATOR_ONLY)
    );
  }

  return next();
};

/** Archived groups stay fully readable but reject every write. */
const requireActiveGroup = (req, res, next) => {
  if (req.group.status !== GROUP_STATUS.ACTIVE) {
    return next(
      new ConflictError("This group is archived and is now read-only", ERROR_CODES.GROUP_ARCHIVED)
    );
  }
  return next();
};

module.exports = { loadGroup, resolveMember, requireMember, requireCreator, requireActiveGroup };
