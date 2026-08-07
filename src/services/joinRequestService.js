const JoinRequest = require("../models/joinRequest");
const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const memberService = require("./memberService");
const activityService = require("./activityService");
const pushService = require("./pushService");
const { normalizeJoinCode, isValidJoinCode } = require("../utils/joinCode");
const config = require("../config/env");
const {
  ACTIVITY_TYPES,
  ERROR_CODES,
  GROUP_STATUS,
  JOIN_REQUEST_STATUS,
  LIMITS,
} = require("../constants");
const { NotFoundError, ConflictError, ValidationError, ForbiddenError } = require("../errors");
const logger = require("../utils/logger");

/**
 * Knocking on a group's door (docs/13-JOIN-APPROVAL.md).
 *
 * ## What changed, and why it is a security fix rather than a feature
 *
 * Resolving a short join code used to return the group's invite code — so a
 * correct guess was full access to everyone's expenses, names and balances. The
 * short code is ~37 bits, typed by hand, and the rate limiter slows enumeration
 * without preventing it.
 *
 * Now a correct code produces a **request**. The invite code is withheld until a
 * member accepts, so guessing a code buys nothing except the chance to appear in
 * somebody's notification tray and be declined. The 96-bit invite link is
 * untouched: it is a deliberate share, and gating it would break the promise the
 * product is built on.
 */

/** Short by design — see config/env.js `join.requestTtlMinutes`. */
const ttlMs = () => config.join.requestTtlMinutes * 60 * 1000;

/** One group's pending requests, so a stranger cannot bury it in a queue. */
const MAX_PENDING_PER_GROUP = 20;

/**
 * The status as of *now*, not as of the last sweep.
 *
 * The waiting room is 15 minutes and the background sweep also runs every 15
 * minutes, so a row can sit `PENDING` in the database for a quarter of an hour
 * after it stopped being valid. The sweep is bookkeeping; this is the truth. Both
 * exist because the sweep keeps the collection tidy while this keeps every read
 * honest — and every write path re-checks `expiresAt` before acting anyway.
 */
const effectiveStatus = (request) => {
  if (request.status !== JOIN_REQUEST_STATUS.PENDING) return request.status;
  return request.expiresAt <= new Date() ? JOIN_REQUEST_STATUS.EXPIRED : request.status;
};

const toDTO = (request, group) => ({
  id: String(request._id),
  name: request.name,
  status: effectiveStatus(request),
  groupName: group?.name,
  createdAt: request.createdAt,
  expiresAt: request.expiresAt,
  /** So the waiting room can count down rather than spin indefinitely. */
  expiresInMs: Math.max(0, new Date(request.expiresAt).getTime() - Date.now()),
});

/**
 * Ask to join — by short code, or by invite link into a private group.
 *
 * One function for both ways in, because "who is allowed to wait in the room" is
 * one rule and splitting it across two call sites is how the two drift apart.
 * The caller passes whichever handle it has.
 */
const request = async ({ code, inviteCode, group: preloaded, name, deviceId, userAgent = "" }) => {
  if (!deviceId) throw new ValidationError("A device id is required to ask to join");

  const trimmed = String(name || "").trim();
  if (!trimmed) throw new ValidationError("Enter the name you want to be known by");
  if (trimmed.length > LIMITS.MEMBER_NAME_MAX) {
    throw new ValidationError(`Keep the name under ${LIMITS.MEMBER_NAME_MAX} characters`);
  }

  let group = preloaded;

  if (!group && inviteCode) {
    group = await groupRepository.findByInviteCode(inviteCode);
  }

  if (!group && code) {
    const normalized = normalizeJoinCode(code);
    if (!isValidJoinCode(normalized)) {
      throw new NotFoundError("No group found with that code", ERROR_CODES.GROUP_NOT_FOUND);
    }
    group = await groupRepository.findByJoinCode(normalized);
  }

  if (!group || group.status !== GROUP_STATUS.ACTIVE) {
    throw new NotFoundError("No group found with that code", ERROR_CODES.GROUP_NOT_FOUND);
  }

  /**
   * Already a member on this browser — the code was unnecessary. Hand back the
   * invite code directly rather than making someone wait for permission to enter
   * a room they are standing in.
   */
  const existingMember = await memberRepository.findByDevice(group._id, deviceId);
  if (existingMember) {
    return { status: JOIN_REQUEST_STATUS.APPROVED, inviteCode: group.inviteCode, alreadyMember: true };
  }

  /**
   * A public group has no waiting room. Reached when a client asks anyway —
   * a stale tab, or a group switched back to public between the lookup and the
   * ask — and answered with the invite code rather than an error, because the
   * caller is entitled to it and a request nobody will ever see is worse than no
   * request.
   */
  if (!group.isPrivate) {
    return { status: JOIN_REQUEST_STATUS.APPROVED, inviteCode: group.inviteCode, open: true };
  }

  const activeCount = await memberRepository.countActive(group._id);
  if (activeCount >= LIMITS.MAX_MEMBERS_PER_GROUP) {
    throw new ConflictError(
      `This group has reached the limit of ${LIMITS.MAX_MEMBERS_PER_GROUP} members`,
      ERROR_CODES.MEMBER_LIMIT_REACHED
    );
  }

  const pending = await JoinRequest.countDocuments({
    groupId: group._id,
    status: JOIN_REQUEST_STATUS.PENDING,
  });
  if (pending >= MAX_PENDING_PER_GROUP) {
    throw new ConflictError(
      "This group has too many requests waiting. Try again later.",
      ERROR_CODES.RATE_LIMITED
    );
  }

  /**
   * Re-asking is fine; asking twice at once is not. The partial unique index does
   * the enforcing, so a race between two taps ends in a duplicate-key error rather
   * than two rows — caught here and turned back into the existing request.
   */
  let created;
  try {
    created = await JoinRequest.create({
      groupId: group._id,
      deviceId,
      name: trimmed,
      status: JOIN_REQUEST_STATUS.PENDING,
      expiresAt: new Date(Date.now() + ttlMs()),
      userAgent: String(userAgent).slice(0, 300),
    });
  } catch (err) {
    if (err?.code === 11000) {
      const already = await JoinRequest.findOne({
        groupId: group._id,
        deviceId,
        status: JOIN_REQUEST_STATUS.PENDING,
      });
      return { ...toDTO(already, group), pending: true };
    }
    throw err;
  }

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.JOIN_REQUESTED,
    actor: { _id: null, name: trimmed },
    message: `${trimmed} asked to join`,
    metadata: { requestId: String(created._id) },
  });

  // Best effort: the request exists whether or not anybody's phone lights up.
  pushService.notifyJoinRequest({ group, joinRequest: created }).catch((err) => {
    logger.warn(`[join] Could not notify members of a join request: ${err.message}`);
  });

  return { ...toDTO(created, group), pending: true };
};

/**
 * "That's me — I lost my browser."
 *
 * ## Why this exists at all
 *
 * A `deviceId` lives in `localStorage`, and "clear site data" takes it with
 * everything else. There is no corner of a browser that survives that, and no
 * stable device identifier the web will give us — so a returning member arrives
 * as a stranger, and their old row still lists the dead device.
 *
 * `memberService.claimMember` refuses that row precisely because it looks taken,
 * which is correct for "someone else is already using this name" and useless for
 * the case it was written for. This is the way through: ask, and let somebody who
 * knows them answer.
 *
 * Approval attaches the new browser to the existing member — so the expenses they
 * entered, the balance they carry and the name everyone knows all stay put. A new
 * member row would have split one person into two and broken every settlement
 * suggestion that mentions them.
 */
const requestClaim = async ({ group, memberId, deviceId, userAgent = "" }) => {
  if (!deviceId) throw new ValidationError("A device id is required");

  const member = await memberRepository.findById(group._id, memberId);
  if (!member || !member.isActive) {
    throw new NotFoundError("Member not found", ERROR_CODES.MEMBER_NOT_FOUND);
  }

  // Already this device's identity — nothing to recover.
  const devices = [...(member.deviceIds || []), member.deviceId].filter(Boolean);
  if (devices.includes(deviceId)) {
    return { status: JOIN_REQUEST_STATUS.APPROVED, inviteCode: group.inviteCode, alreadyMine: true };
  }

  let created;
  try {
    created = await JoinRequest.create({
      groupId: group._id,
      deviceId,
      name: member.name,
      claimMemberId: member._id,
      status: JOIN_REQUEST_STATUS.PENDING,
      expiresAt: new Date(Date.now() + ttlMs()),
      userAgent: String(userAgent).slice(0, 300),
    });
  } catch (err) {
    if (err?.code === 11000) {
      const already = await JoinRequest.findOne({
        groupId: group._id,
        deviceId,
        status: JOIN_REQUEST_STATUS.PENDING,
      });
      return { ...toDTO(already, group), pending: true };
    }
    throw err;
  }

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.JOIN_REQUESTED,
    actor: { _id: null, name: member.name },
    message: `${member.name} is trying to get back in from a new device`,
    metadata: { requestId: String(created._id), claim: true },
  });

  pushService.notifyJoinRequest({ group, joinRequest: created, isClaim: true }).catch(() => {});

  return { ...toDTO(created, group), pending: true, claim: true };
};

/** Where the requester's own polling looks. Scoped to their device, not public. */
const statusFor = async ({ requestId, deviceId }) => {
  const found = await JoinRequest.findOne({ _id: requestId, deviceId });
  if (!found) {
    throw new NotFoundError("Request not found", ERROR_CODES.JOIN_REQUEST_NOT_FOUND);
  }

  const group = await groupRepository.findById(found.groupId);
  const dto = toDTO(found, group);

  return {
    ...dto,
    /**
     * The invite code appears here and nowhere else, and only once a member has
     * said yes. Everything upstream of this line treats a correct short code as a
     * knock rather than a key.
     */
    inviteCode: dto.status === JOIN_REQUEST_STATUS.APPROVED ? group?.inviteCode : undefined,
  };
};

/** What the group's members see. */
const listPending = async (group) => {
  const rows = await JoinRequest.find({
    groupId: group._id,
    status: JOIN_REQUEST_STATUS.PENDING,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();

  return rows.map((row) => toDTO(row, group));
};

/**
 * Accept or decline.
 *
 * Any active member may decide. Not only the creator: a creator who is asleep is
 * a group nobody can join, and the trust model here is already flat — every
 * member can add expenses that change what everyone owes, which is a strictly
 * bigger power than admitting a person the group is standing next to.
 */
const decide = async ({ group, actor, requestId, approve }) => {
  if (!actor?._id) {
    throw new ForbiddenError("Only a member can answer join requests");
  }

  const found = await JoinRequest.findOne({ _id: requestId, groupId: group._id });
  if (!found) {
    throw new NotFoundError("Request not found", ERROR_CODES.JOIN_REQUEST_NOT_FOUND);
  }

  if (found.status !== JOIN_REQUEST_STATUS.PENDING) {
    /**
     * Someone else already answered, or it expired. Not an error the user needs
     * to act on — two people tapping Accept on the same notification is the
     * expected case, not a fault — so the existing outcome is returned rather
     * than an exception that reads like something broke.
     */
    return { ...toDTO(found, group), alreadyDecided: true };
  }

  if (found.expiresAt <= new Date()) {
    found.status = JOIN_REQUEST_STATUS.EXPIRED;
    await found.save();
    throw new ConflictError(
      "That request has expired. Ask them to try again.",
      ERROR_CODES.JOIN_REQUEST_ALREADY_DECIDED
    );
  }

  /**
   * Claim the decision atomically before doing anything with consequences. Two
   * members tapping Accept at the same moment would otherwise both proceed, and
   * `joinGroup` is only idempotent per device — the second call would return the
   * first one's member, but the activity log would show the join twice.
   */
  const claimed = await JoinRequest.findOneAndUpdate(
    { _id: found._id, status: JOIN_REQUEST_STATUS.PENDING },
    {
      $set: {
        status: approve ? JOIN_REQUEST_STATUS.APPROVED : JOIN_REQUEST_STATUS.DECLINED,
        decidedByMemberId: actor._id,
        decidedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!claimed) {
    const current = await JoinRequest.findById(found._id);
    return { ...toDTO(current, group), alreadyDecided: true };
  }

  if (!approve) {
    await activityService.record({
      groupId: group._id,
      type: ACTIVITY_TYPES.JOIN_DECLINED,
      actor,
      message: `${actor.name} declined ${claimed.name}'s request to join`,
      metadata: { requestId: String(claimed._id) },
    });

    pushService.notifyJoinDecision({ group, joinRequest: claimed, approved: false }).catch(() => {});
    return toDTO(claimed, group);
  }

  /**
   * A recovery reattaches the existing member; a join creates a new one.
   *
   * The distinction matters more than it looks: creating a fresh member for
   * someone who already has expenses in the group would split one person into
   * two, leaving half their spending under a name nobody recognises and every
   * settlement suggestion mentioning both.
   */
  let member;

  if (claimed.claimMemberId) {
    const recovered = await memberService.attachDevice({
      group,
      memberId: claimed.claimMemberId,
      deviceId: claimed.deviceId,
      // The old device id is dead — its storage was cleared — so it is dropped
      // rather than left to accumulate on the row forever.
      replaceExisting: true,
    });

    member = recovered;
  } else {
    // The ordinary join path, so a member admitted this way is identical to one
    // who arrived by link — same validation, same limit checks, same activity.
    ({ member } = await memberService.joinGroup({
      group,
      name: claimed.name,
      deviceId: claimed.deviceId,
    }));
  }

  claimed.memberId = member.id;
  await claimed.save();

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.JOIN_APPROVED,
    actor,
    message: `${actor.name} let ${claimed.name} in`,
    metadata: { requestId: String(claimed._id), memberId: String(member.id) },
  });

  pushService.notifyJoinDecision({ group, joinRequest: claimed, approved: true }).catch(() => {});

  return { ...toDTO(claimed, group), memberId: String(member.id) };
};

/** Withdrawing, from the requester's own device. */
const cancel = async ({ requestId, deviceId }) => {
  const updated = await JoinRequest.findOneAndUpdate(
    { _id: requestId, deviceId, status: JOIN_REQUEST_STATUS.PENDING },
    { $set: { status: JOIN_REQUEST_STATUS.CANCELLED } },
    { new: true }
  );

  if (!updated) {
    throw new NotFoundError("Request not found", ERROR_CODES.JOIN_REQUEST_NOT_FOUND);
  }

  return toDTO(updated, null);
};

/**
 * Mark the abandoned ones expired.
 *
 * A status rather than a deletion, so "did anyone ever ask?" stays answerable —
 * and so a tap on a week-old notification lands on something that explains
 * itself instead of a missing row.
 */
const expireStale = async () => {
  const result = await JoinRequest.updateMany(
    { status: JOIN_REQUEST_STATUS.PENDING, expiresAt: { $lte: new Date() } },
    { $set: { status: JOIN_REQUEST_STATUS.EXPIRED } }
  );
  return result.modifiedCount || 0;
};

module.exports = {
  request,
  requestClaim,
  statusFor,
  listPending,
  decide,
  cancel,
  expireStale,
  effectiveStatus,
  ttlMs,
};
