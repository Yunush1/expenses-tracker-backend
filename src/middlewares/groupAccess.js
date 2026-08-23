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
    /**
     * 410, but not a dead end for the one person who can undo it.
     *
     * Deleting is a soft delete, and the creator may restore it
     * (`groupService.restoreGroup`). The client cannot know that from a bare 410 —
     * and it cannot ask, because every route on this group answers the same 410 —
     * so the one fact that makes the next step possible travels with the refusal.
     *
     * Costs a member lookup on a path that is already rare, and discloses nothing
     * to anyone else: a non-creator, and anyone holding the link who was never a
     * member, gets `canRestore: false` and the same message they got before.
     */
    const error = new GoneError("This group has been deleted", ERROR_CODES.GROUP_DELETED);

    const member = req.deviceId
      ? await memberRepository.findByDevice(group._id, req.deviceId)
      : null;

    error.details = { canRestore: Boolean(member?.isCreator), name: group.name };
    throw error;
  }

  req.group = group;
  return next();
});

/**
 * `:inviteCode` → `req.group`, *including* a deleted one.
 *
 * Only the restore route mounts this, and it is deliberately a separate export
 * rather than a flag on `loadGroup`: a boolean parameter on the guard that keeps
 * deleted groups out of every other route is one wrong argument away from
 * exposing them all, and the wrong argument would look entirely reasonable at the
 * call site.
 */
const loadGroupIncludingDeleted = asyncHandler(async (req, res, next) => {
  const { inviteCode } = req.params;

  if (!isValidInviteCode(inviteCode)) {
    throw new NotFoundError("Group not found", ERROR_CODES.GROUP_NOT_FOUND);
  }

  const group = await groupRepository.findByInviteCode(inviteCode);

  if (!group) {
    throw new NotFoundError("Group not found", ERROR_CODES.GROUP_NOT_FOUND);
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

module.exports = {
  loadGroup,
  loadGroupIncludingDeleted,
  resolveMember,
  requireMember,
  requireCreator,
  requireActiveGroup,
};
