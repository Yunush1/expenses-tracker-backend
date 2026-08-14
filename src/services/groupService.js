const config = require("../config/env");
const { withTransaction } = require("../config/db");
const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const activityService = require("./activityService");
const balanceService = require("./balanceService");
const entitlementService = require("./entitlementService");
const { generateInviteCode } = require("../utils/inviteCode");
const { generateJoinCode, normalizeJoinCode, isValidJoinCode } = require("../utils/joinCode");
const {
  toGroupDTO,
  toEntitlementDTO,
  toMemberDTO,
  toPublicMemberDTO,
  toBalanceDTO,
} = require("../serializers");
const { ACTIVITY_TYPES, GROUP_STATUS, DEFAULT_CURRENCY, ERROR_CODES, LIMITS } = require("../constants");
const { ApiError, ConflictError, BadRequestError, NotFoundError } = require("../errors");
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

/**
 * Resolves the join code a group should be created with.
 *
 * `null` means the caller explicitly wants none — link only. A supplied code is
 * validated and checked for collisions; anything else gets a generated one, which
 * is the default because a group nobody can type their way into is the very thing
 * this was added to fix.
 */
const resolveJoinCode = async (requested, { allowNull = true } = {}) => {
  if (requested === null && allowNull) return null;

  if (requested !== undefined && requested !== null && String(requested).trim() !== "") {
    const normalized = normalizeJoinCode(requested);

    if (!isValidJoinCode(normalized)) {
      throw new BadRequestError(
        `A code needs ${LIMITS.JOIN_CODE_MIN}–${LIMITS.JOIN_CODE_MAX} letters or numbers. ` +
          "Spaces and dashes are fine — they are ignored.",
        ERROR_CODES.INVALID_JOIN_CODE
      );
    }

    if (await groupRepository.existsByJoinCode(normalized)) {
      throw new ConflictError(
        `The code ${normalized} is already taken. Try another.`,
        ERROR_CODES.JOIN_CODE_TAKEN
      );
    }

    return normalized;
  }

  return allocateJoinCode();
};

/** Same retry-on-collision shape as the invite code, but far likelier to collide. */
const allocateJoinCode = async (attempts = 5) => {
  for (let i = 0; i < attempts; i += 1) {
    const code = generateJoinCode();
    // eslint-disable-next-line no-await-in-loop -- sequential by nature
    if (!(await groupRepository.existsByJoinCode(code))) return code;
    logger.warn("[groupService] Join code collision, retrying");
  }
  throw new ApiError("Could not allocate a join code", 500, ERROR_CODES.INTERNAL_ERROR);
};

/**
 * Short code → the group's *name*, and nothing else.
 *
 * ## This used to return the invite code, and that was the bug
 *
 * The short code is 8 characters from a 25-letter alphabet — about 37 bits, typed
 * by hand, sometimes read aloud across a table. The strict rate limiter on this
 * route slows enumeration; it does not prevent it. So returning the invite code
 * here meant a guessed code was **full access**: every expense, every name, every
 * balance, no further step.
 *
 * Now it returns only enough to show "Is this the group you meant?" and the caller
 * has to ask a member to be let in (docs/13-JOIN-APPROVAL.md). Guessing a code now
 * buys the chance to appear in somebody's notification tray and be declined.
 *
 * A wrong code and a deleted group are still reported identically: neither should
 * confirm that some other group exists.
 */
const lookupByJoinCode = async (code, deviceId) => {
  const normalized = normalizeJoinCode(code);

  if (!isValidJoinCode(normalized)) {
    throw new NotFoundError("No group found with that code", ERROR_CODES.GROUP_NOT_FOUND);
  }

  const group = await groupRepository.findByJoinCode(normalized);

  if (!group || group.status !== GROUP_STATUS.ACTIVE) {
    throw new NotFoundError("No group found with that code", ERROR_CODES.GROUP_NOT_FOUND);
  }

  /**
   * Already a member on this browser — approval would be theatre. Requires the
   * device to already be in the group, which a guesser's is not.
   */
  if (deviceId) {
    const existing = await memberRepository.findByDevice(group._id, deviceId);
    if (existing) {
      return { groupName: group.name, memberCount: group.memberCount, inviteCode: group.inviteCode };
    }
  }

  /**
   * A public group behaves as it always has: the code resolves to the link and
   * the normal join screen takes over.
   *
   * Stated plainly, because it is the residual risk the privacy switch exists to
   * manage: for a public group, a guessed short code still reaches the group. The
   * code is ~37 bits behind the strictest limiter in the API, which makes that
   * expensive rather than impossible. A group that wants the guarantee rather
   * than the odds turns on `isPrivate`, and then nothing — not the code, not the
   * link — admits anyone without a member agreeing.
   */
  if (!group.isPrivate) {
    return { groupName: group.name, memberCount: group.memberCount, inviteCode: group.inviteCode };
  }

  return {
    groupName: group.name,
    memberCount: group.memberCount,
    /** Tells the client to collect a name and ask, rather than navigate. */
    requiresApproval: true,
  };
};

const createGroup = async ({ name, description, creatorName, deviceId, currency, joinCode }) => {
  const inviteCode = await allocateInviteCode();
  const resolvedJoinCode = await resolveJoinCode(joinCode);

  const result = await withTransaction(async (session) => {
    const group = await groupRepository.create(
      {
        name,
        description: description || "",
        inviteCode,
        joinCode: resolvedJoinCode,
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
          deviceIds: deviceId ? [deviceId] : [],
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

  const [members, balanceResult, entitlement] = await Promise.all([
    memberRepository.findByGroup(group._id),
    balanceService.computeBalances(group._id),
    /**
     * The plan rides along here rather than on an endpoint of its own
     * (docs/22-MONETIZATION.md §6). It is read by every screen that could show a
     * locked feature, and a second round trip for a boolean is a second thing to
     * be stale — the version where the header says "Pro" and the button beside it
     * says "upgrade".
     */
    entitlementService.forGroup(group._id),
  ]);

  const myBalance = balanceService.getMemberBalance(balanceResult, currentMemberId);

  return {
    group: toGroupDTO(group),
    entitlement: toEntitlementDTO(entitlement),
    members: members.map((member) => toMemberDTO(member, currentMemberId)),
    totals: balanceResult.totals,
    currentMember: currentMember ? toMemberDTO(currentMember, currentMemberId) : null,
    myBalance: myBalance ? toBalanceDTO(myBalance, currentMemberId, group.currency) : null,
    isMember: Boolean(currentMember),
    isSettled: balanceResult.isSettled,
    inviteUrl: buildInviteUrl(group.inviteCode),
  };
};

const updateGroup = async ({ group, actor, name, description, joinCode, isPrivate }) => {
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;

  /**
   * Turning approval on or off.
   *
   * It changes only who may join *next*. Existing members are untouched — locking
   * a door does not evict the people already inside, and a switch that removed
   * members would be a far more dangerous control than it looks.
   */
  let privacyChange = null;
  if (isPrivate !== undefined && Boolean(isPrivate) !== Boolean(group.isPrivate)) {
    update.isPrivate = Boolean(isPrivate);
    privacyChange = update.isPrivate ? "private" : "open";
  }

  /**
   * `joinCode` is three requests in one field, which is what makes it revocable:
   *   null / ""  → turn the short code off; the link becomes the only way in
   *   "REGENERATE" → replace it, invalidating whatever was shared before
   *   anything else → set that exact code, if it is free
   */
  let joinCodeChange = null;

  if (joinCode !== undefined) {
    if (joinCode === null || String(joinCode).trim() === "") {
      update.joinCode = null;
      joinCodeChange = "removed";
    } else if (String(joinCode).trim().toUpperCase() === "REGENERATE") {
      update.joinCode = await allocateJoinCode();
      joinCodeChange = "regenerated";
    } else if (normalizeJoinCode(joinCode) !== group.joinCode) {
      update.joinCode = await resolveJoinCode(joinCode, { allowNull: false });
      joinCodeChange = "changed";
    }
  }

  if (Object.keys(update).length === 0) {
    return toGroupDTO(group);
  }

  update.lastActivityAt = new Date();
  const updated = await groupRepository.updateById(group._id, { $set: update });

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.GROUP_UPDATED,
    actor,
    message: privacyChange
      ? privacyChange === "private"
        ? `${actor.name} made the group private — new people need approval`
        : `${actor.name} opened the group — anyone with the link can join`
      : joinCodeChange
        ? `${actor.name} ${joinCodeChange} the group's join code`
        : `${actor.name} updated the group details`,
    // Never the code itself — the activity feed is readable by every member and a
    // retired code should not stay legible in it.
    metadata: { name: updated.name, joinCodeChange, privacyChange },
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
  lookupByJoinCode,
  updateGroup,
  archiveGroup,
  deleteGroup,
  buildInviteUrl,
};
