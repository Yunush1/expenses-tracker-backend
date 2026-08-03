const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const expenseRepository = require("../repositories/expenseRepository");
const settlementRepository = require("../repositories/settlementRepository");
const activityService = require("./activityService");
const { toMemberDTO } = require("../serializers");
const { ACTIVITY_TYPES, LIMITS, ERROR_CODES } = require("../constants");
const { NotFoundError, ConflictError, ForbiddenError } = require("../errors");

const listMembers = async (group, currentMember) => {
  const members = await memberRepository.findByGroup(group._id);
  return members.map((member) => toMemberDTO(member, currentMember?._id));
};

/**
 * Joining is idempotent per device: a double-tap or a refresh mid-request must
 * not create a second person with the same name.
 */
const joinGroup = async ({ group, name, deviceId }) => {
  const existing = await memberRepository.findByDevice(group._id, deviceId);
  if (existing) {
    return { member: toMemberDTO(existing, existing._id), created: false };
  }

  const activeCount = await memberRepository.countActive(group._id);
  if (activeCount >= LIMITS.MAX_MEMBERS_PER_GROUP) {
    throw new ConflictError(
      `This group has reached the limit of ${LIMITS.MAX_MEMBERS_PER_GROUP} members`,
      ERROR_CODES.MEMBER_LIMIT_REACHED
    );
  }

  const member = await memberRepository.create({
    groupId: group._id,
    name,
    deviceId: deviceId || null,
    isCreator: false,
    isActive: true,
  });

  await groupRepository.incrementMemberCount(group._id, 1);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.MEMBER_JOINED,
    actor: member,
    message: `${member.name} joined the group`,
    metadata: { memberId: String(member._id) },
  });

  return { member: toMemberDTO(member, member._id), created: true };
};

/**
 * Binds an existing device-less member to this browser. Covers both "someone
 * added me by name" and "I cleared my browser data and lost my identity".
 */
const claimMember = async ({ group, memberId, deviceId }) => {
  const member = await memberRepository.findById(group._id, memberId);

  if (!member || !member.isActive) {
    throw new NotFoundError("Member not found", ERROR_CODES.MEMBER_NOT_FOUND);
  }

  if (member.deviceId && member.deviceId !== deviceId) {
    throw new ConflictError(
      `${member.name} is already linked to another device`,
      ERROR_CODES.ALREADY_CLAIMED
    );
  }

  // Releases any other identity this device held in the group, so a device maps
  // to exactly one member and resolveMember stays unambiguous.
  const previous = await memberRepository.findByDevice(group._id, deviceId);
  if (previous && String(previous._id) !== String(member._id)) {
    await memberRepository.updateById(group._id, previous._id, { $set: { deviceId: null } });
  }

  const updated = await memberRepository.updateById(group._id, member._id, {
    $set: { deviceId },
  });

  return toMemberDTO(updated, updated._id);
};

/** Manual add — someone who is not at the table yet, e.g. "Dad". */
const addMember = async ({ group, actor, name }) => {
  const activeCount = await memberRepository.countActive(group._id);
  if (activeCount >= LIMITS.MAX_MEMBERS_PER_GROUP) {
    throw new ConflictError(
      `This group has reached the limit of ${LIMITS.MAX_MEMBERS_PER_GROUP} members`,
      ERROR_CODES.MEMBER_LIMIT_REACHED
    );
  }

  const member = await memberRepository.create({
    groupId: group._id,
    name,
    deviceId: null,
    isCreator: false,
    isActive: true,
  });

  await groupRepository.incrementMemberCount(group._id, 1);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.MEMBER_ADDED,
    actor,
    message: `${actor.name} added ${member.name}`,
    metadata: { memberId: String(member._id), memberName: member.name },
  });

  return toMemberDTO(member, actor?._id);
};

const renameMember = async ({ group, actor, memberId, name }) => {
  const member = await memberRepository.findById(group._id, memberId);

  if (!member || !member.isActive) {
    throw new NotFoundError("Member not found", ERROR_CODES.MEMBER_NOT_FOUND);
  }

  const isSelf = String(member._id) === String(actor._id);
  if (!isSelf && !actor.isCreator) {
    throw new ForbiddenError("Only the group creator can rename other members", ERROR_CODES.CREATOR_ONLY);
  }

  const previousName = member.name;
  const updated = await memberRepository.updateById(group._id, member._id, { $set: { name } });

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.MEMBER_RENAMED,
    actor,
    message: `${previousName} is now ${updated.name}`,
    metadata: { memberId: String(member._id), from: previousName, to: updated.name },
  });

  return toMemberDTO(updated, actor._id);
};

/**
 * Removal is refused for anyone who appears in a live expense or settlement.
 *
 * Deleting them would orphan their shares and break the zero-sum invariant that
 * every balance and settlement suggestion depends on — so the caller gets an
 * actionable 409 instead of a silently corrupted ledger.
 */
const removeMember = async ({ group, actor, memberId }) => {
  const member = await memberRepository.findById(group._id, memberId);

  if (!member || !member.isActive) {
    throw new NotFoundError("Member not found", ERROR_CODES.MEMBER_NOT_FOUND);
  }

  if (member.isCreator) {
    throw new ConflictError("The group creator cannot be removed", ERROR_CODES.MEMBER_HAS_ACTIVITY);
  }

  const [expenseCount, settlementCount] = await Promise.all([
    expenseRepository.countInvolvingMember(group._id, member._id),
    settlementRepository.countInvolvingMember(group._id, member._id),
  ]);

  if (expenseCount > 0 || settlementCount > 0) {
    throw new ConflictError(
      `${member.name} is part of ${expenseCount} expense(s) and ${settlementCount} settlement(s) and cannot be removed. Delete or reassign those first.`,
      ERROR_CODES.MEMBER_HAS_ACTIVITY,
      [{ field: "memberId", message: `expenseCount: ${expenseCount}, settlementCount: ${settlementCount}` }]
    );
  }

  await memberRepository.deactivate(group._id, member._id);
  await groupRepository.incrementMemberCount(group._id, -1);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.MEMBER_REMOVED,
    actor,
    message: `${actor.name} removed ${member.name}`,
    metadata: { memberId: String(member._id), memberName: member.name },
  });

  return true;
};

/** Name lookup used by the expense/settlement serializers. */
const buildNameMap = async (groupId) => {
  const members = await memberRepository.findByGroup(groupId, { includeInactive: true });
  return new Map(members.map((member) => [String(member._id), member.name]));
};

module.exports = {
  listMembers,
  joinGroup,
  claimMember,
  addMember,
  renameMember,
  removeMember,
  buildNameMap,
};
