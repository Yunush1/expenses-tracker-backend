const config = require("../config/env");
const { withTransaction } = require("../config/db");
const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const activityService = require("./activityService");
const balanceService = require("./balanceService");
const { generateInviteCode } = require("../utils/inviteCode");
const { toGroupDTO, toMemberDTO, toPublicMemberDTO, toBalanceDTO } = require("../serializers");
const { ACTIVITY_TYPES, GROUP_STATUS, DEFAULT_CURRENCY, ERROR_CODES } = require("../constants");
const { ApiError, ConflictError } = require("../errors");
const logger = require("../utils/logger");

const buildInviteUrl = (inviteCode) => `${config.appBaseUrl}/join/${inviteCode}`;

/** Retries on the astronomically unlikely 96-bit collision rather than 500ing. */
const allocateInviteCode = async (attempts = 3) => {
  for (let i = 0; i < attempts; i += 1) {
    const code = generateInviteCode();
    // eslint-disable-next-line no-await-in-loop -- sequential by nature; runs once in practice
    if (!(await groupRepository.existsByInviteCode(code))) return code;
    logger.warn("[groupService] Invite code collision, retrying");
  }
  throw new ApiError("Could not allocate an invite code", 500, ERROR_CODES.INTERNAL_ERROR);
};

const createGroup = async ({ name, description, creatorName, deviceId, currency }) => {
  const inviteCode = await allocateInviteCode();

  const result = await withTransaction(async (session) => {
    const group = await groupRepository.create(
      {
        name,
        description: description || "",
        inviteCode,
        currency: currency || DEFAULT_CURRENCY,
        createdByDeviceId: deviceId || null,
        memberCount: 1,
        status: GROUP_STATUS.ACTIVE,
        lastActivityAt: new Date(),
      },
      session
    );

    try {
      const member = await memberRepository.create(
        {
          groupId: group._id,
          name: creatorName,
          deviceId: deviceId || null,
          isCreator: true,
          isActive: true,
        },
        session
      );

      return { group, member };
    } catch (err) {
      // Without a replica set there is no transaction to roll back, so compensate
      // explicitly: a group with no creator is unusable and must not survive.
      if (!session) {
        await groupRepository.deleteHard(group._id).catch(() => null);
      }
      throw err;
    }
  });

  const { group, member } = result;

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.GROUP_CREATED,
    actor: member,
    message: `${member.name} created "${group.name}"`,
    metadata: { groupName: group.name },
  });

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.MEMBER_JOINED,
    actor: member,
    message: `${member.name} joined the group`,
    metadata: { memberId: String(member._id) },
  });

  logger.info(`[groupService] Created group ${group._id} (${inviteCode})`);

  return {
    group: toGroupDTO(group),
    member: toMemberDTO(member, member._id),
    inviteUrl: buildInviteUrl(group.inviteCode),
  };
};

/**
 * The pre-join screen: enough to recognise the group and pick your identity,
 * deliberately without any financial data.
 */
const getPreview = async (group, currentMember) => {
  const members = await memberRepository.findByGroup(group._id);

  return {
    group: {
      name: group.name,
      description: group.description || "",
      memberCount: group.memberCount,
      status: group.status,
      currency: group.currency,
    },
    members: members.map(toPublicMemberDTO),
    isMember: Boolean(currentMember),
    currentMember: currentMember ? toMemberDTO(currentMember, currentMember._id) : null,
    inviteUrl: buildInviteUrl(group.inviteCode),
  };
};

/** One call for the whole dashboard header, so first paint needs one round trip. */
const getSummary = async (group, currentMember) => {
  const currentMemberId = currentMember?._id ?? null;

  const [members, balanceResult] = await Promise.all([
    memberRepository.findByGroup(group._id),
    balanceService.computeBalances(group._id),
  ]);

  const myBalance = balanceService.getMemberBalance(balanceResult, currentMemberId);

  return {
    group: toGroupDTO(group),
    members: members.map((member) => toMemberDTO(member, currentMemberId)),
    totals: balanceResult.totals,
    currentMember: currentMember ? toMemberDTO(currentMember, currentMemberId) : null,
    myBalance: myBalance ? toBalanceDTO(myBalance, currentMemberId, group.currency) : null,
    isMember: Boolean(currentMember),
    isSettled: balanceResult.isSettled,
    inviteUrl: buildInviteUrl(group.inviteCode),
  };
};

const updateGroup = async ({ group, actor, name, description }) => {
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;

  if (Object.keys(update).length === 0) {
    return toGroupDTO(group);
  }

  update.lastActivityAt = new Date();
  const updated = await groupRepository.updateById(group._id, { $set: update });

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.GROUP_UPDATED,
    actor,
    message: `${actor.name} updated the group details`,
    metadata: { name: updated.name },
  });

  return toGroupDTO(updated);
};

const archiveGroup = async ({ group, actor }) => {
  if (group.status === GROUP_STATUS.ARCHIVED) {
    throw new ConflictError("Group is already archived", ERROR_CODES.GROUP_ARCHIVED);
  }

  const updated = await groupRepository.setStatus(group._id, GROUP_STATUS.ARCHIVED);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.GROUP_ARCHIVED,
    actor,
    message: `${actor.name} archived the group`,
    metadata: {},
  });

  return toGroupDTO(updated);
};

/** Soft delete — data is retained, every route thereafter returns 410. */
const deleteGroup = async ({ group }) => {
  await groupRepository.setStatus(group._id, GROUP_STATUS.DELETED);
  logger.info(`[groupService] Deleted group ${group._id}`);
  return true;
};

module.exports = {
  createGroup,
  getPreview,
  getSummary,
  updateGroup,
  archiveGroup,
  deleteGroup,
  buildInviteUrl,
};
