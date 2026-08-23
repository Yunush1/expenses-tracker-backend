const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const expenseRepository = require("../repositories/expenseRepository");
const settlementRepository = require("../repositories/settlementRepository");
const activityService = require("./activityService");
// No cycle: the mirror service reaches for models and the ledger, never back here.
const ledgerMirrorService = require("./ledgerMirrorService");
const cacheService = require("./cacheService");
const logger = require("../utils/logger");
const { withTransaction } = require("../config/db");
const { toMemberDTO } = require("../serializers");
const { generateLinkCode, hashLinkCode, normalizeLinkCode } = require("../utils/linkCode");
const { remapExpense, remapSettlement, assertExpenseIntact } = require("../utils/memberMerge");
const { formatMinor } = require("../utils/money");
const { ACTIVITY_TYPES, LIMITS, ERROR_CODES } = require("../constants");
const { NotFoundError, ConflictError, ForbiddenError, BadRequestError } = require("../errors");

/** Devices live in `deviceIds[]`; the legacy scalar is still honoured pre-migration. */
const devicesOf = (member) => {
  const ids = new Set(member.deviceIds || []);
  if (member.deviceId) ids.add(member.deviceId);
  return [...ids];
};

/**
 * Cached per viewer, not just per group: `toMemberDTO` sets `isYou`, so one
 * cached copy served to everybody would tell each member they are the last
 * person who asked.
 */
const listMembers = async (group, currentMember) =>
  cacheService.rememberGroup(
    group._id,
    `members:${currentMember?._id || "anon"}`,
    async () => {
      const members = await memberRepository.findByGroup(group._id);
      return members.map((member) => toMemberDTO(member, currentMember?._id));
    }
  );

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
    deviceIds: deviceId ? [deviceId] : [],
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
 * Attach a browser to a member that already has one — an approved recovery.
 *
 * Separate from `claimMember` on purpose. That one refuses a member whose device
 * list is non-empty, which is the right answer to "somebody else is already using
 * this name" and the wrong answer to "that somebody is me, and I cleared my
 * browser". The difference between those two is a fact only another human knows,
 * so this is reachable **only** through an approved join request — never from a
 * request a client can make on its own behalf (docs/13-JOIN-APPROVAL.md §11).
 *
 * @param replaceExisting drop the member's other devices. True for a recovery,
 *   where the old id belongs to storage that no longer exists; a second working
 *   device should use the link-code flow instead, which keeps both.
 */
const attachDevice = async ({ group, memberId, deviceId, replaceExisting = false }) => {
  const member = await memberRepository.findById(group._id, memberId);

  if (!member || !member.isActive) {
    throw new NotFoundError("Member not found", ERROR_CODES.MEMBER_NOT_FOUND);
  }

  // One device maps to exactly one member, or resolveMember becomes ambiguous.
  const previous = await memberRepository.findByDevice(group._id, deviceId);
  if (previous && String(previous._id) !== String(member._id)) {
    await memberRepository.removeDevice(group._id, previous._id, deviceId);
  }

  if (replaceExisting) {
    for (const stale of devicesOf(member).filter((id) => id !== deviceId)) {
      // eslint-disable-next-line no-await-in-loop -- at most a handful
      await memberRepository.removeDevice(group._id, member._id, stale);
    }
  }

  const updated = await memberRepository.addDevice(group._id, member._id, deviceId);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.DEVICE_LINKED,
    actor: updated,
    message: `${updated.name} got back in from a new device`,
    metadata: { memberId: String(updated._id), recovered: replaceExisting },
  });

  return toMemberDTO(updated, updated._id);
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

  const devices = devicesOf(member);

  if (devices.length > 0 && !devices.includes(deviceId)) {
    throw new ConflictError(
      `${member.name} is already in use on another device. Open Splitly there and use "Add another device" to get a link code.`,
      ERROR_CODES.ALREADY_CLAIMED
    );
  }

  // Releases any other identity this device held in the group, so a device maps
  // to exactly one member and resolveMember stays unambiguous.
  const previous = await memberRepository.findByDevice(group._id, deviceId);
  if (previous && String(previous._id) !== String(member._id)) {
    await memberRepository.removeDevice(group._id, previous._id, deviceId);
  }

  const updated = await memberRepository.addDevice(group._id, member._id, deviceId);

  return toMemberDTO(updated, updated._id);
};

/**
 * Issues a code on a device that is already this member's, to be typed into one
 * that is not.
 *
 * The alternative — letting any device claim any member — would make possession of
 * the invite link enough to become someone else and rewrite their balances. So the
 * proof required is possession of a device that is already trusted.
 */
const createDeviceLinkCode = async ({ group, actor }) => {
  if (devicesOf(actor).length >= LIMITS.MAX_DEVICES_PER_MEMBER) {
    throw new ConflictError(
      `${actor.name} is already on ${LIMITS.MAX_DEVICES_PER_MEMBER} devices. Remove one before adding another.`,
      ERROR_CODES.DEVICE_LIMIT_REACHED
    );
  }

  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + LIMITS.LINK_CODE_TTL_MS);

  await memberRepository.setLinkCode(group._id, actor._id, hashLinkCode(group._id, code), expiresAt);

  // Returned exactly once — only the hash is stored.
  return { code, expiresAt, memberName: actor.name };
};

/**
 * Redeems a code on the new device.
 *
 * Deliberately not behind `requireMember`: the whole point is that this browser is
 * not yet anybody in this group.
 */
const linkDevice = async ({ group, deviceId, code, userId = null }) => {
  if (!deviceId) {
    throw new BadRequestError("This browser has no device id", ERROR_CODES.VALIDATION_ERROR);
  }

  const member = await memberRepository.findByLinkCodeHash(group._id, hashLinkCode(group._id, code));

  if (!member || !member.linkCode?.expiresAt || member.linkCode.expiresAt.getTime() < Date.now()) {
    /**
     * The group code and a device code are both short strings the UI calls a
     * "code", so entering one where the other belongs is a design failure rather
     * than a user error — and the generic message sends people off to regenerate
     * a code that was never the problem. Name what actually happened.
     */
    if (group.joinCode && normalizeLinkCode(code) === group.joinCode) {
      throw new BadRequestError(
        `${group.joinCode} is the group code — it is how people find this group, and you have already found it. ` +
          "To bring your existing name onto this device, open Splitly on the device that already has it, " +
          'choose "Add another device", and type the device code it shows you.',
        ERROR_CODES.INVALID_LINK_CODE
      );
    }

    // One message for "wrong" and "expired": a code that has run out is still a
    // code that should not confirm it ever existed.
    throw new BadRequestError(
      "That device code is wrong or has expired. Device codes last 10 minutes and work once — generate a fresh one on your other device.",
      ERROR_CODES.INVALID_LINK_CODE
    );
  }

  if (devicesOf(member).length >= LIMITS.MAX_DEVICES_PER_MEMBER) {
    throw new ConflictError(
      `${member.name} is already on ${LIMITS.MAX_DEVICES_PER_MEMBER} devices.`,
      ERROR_CODES.DEVICE_LIMIT_REACHED
    );
  }

  // This browser may already have joined as a duplicate person before linking.
  const previous = await memberRepository.findByDevice(group._id, deviceId);
  let mergeSuggestion = null;

  if (previous && String(previous._id) !== String(member._id)) {
    await memberRepository.removeDevice(group._id, previous._id, deviceId);

    const [expenseCount, settlementCount] = await Promise.all([
      expenseRepository.countInvolvingMember(group._id, previous._id),
      settlementRepository.countInvolvingMember(group._id, previous._id),
    ]);

    if (expenseCount === 0 && settlementCount === 0) {
      // An empty accidental join. Nothing of value is lost by retiring it.
      await memberRepository.deactivate(group._id, previous._id);
      await groupRepository.incrementMemberCount(group._id, -1);
    } else {
      // It has history, so it cannot just be dropped — offer the merge instead.
      mergeSuggestion = {
        memberId: String(previous._id),
        name: previous.name,
        expenseCount,
        settlementCount,
      };
    }
  }

  const updated = await memberRepository.addDevice(group._id, member._id, deviceId);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.DEVICE_LINKED,
    actor: updated,
    message: `${updated.name} linked another device`,
    metadata: { memberId: String(updated._id), deviceCount: devicesOf(updated).length },
  });

  /**
   * One code, both links (docs/17-MEMBER-IDENTITY.md §6.2).
   *
   * Someone setting up a new phone signs in and types the code once; making them
   * repeat the whole flow to attach the account would be a second ceremony for
   * the same intent. This route takes `optionalAuth`, so `userId` is present
   * only when the browser is genuinely signed in.
   *
   * Failure here must not fail the device link — that part already succeeded and
   * is what they came for. The outcome is reported instead, because a client
   * that assumed both worked would tell someone their account is linked when a
   * refusal (§10) says otherwise.
   */
  let accountLinked = false;
  let accountLinkError = null;

  if (userId) {
    try {
      const result = await linkAccount({ group, member: updated, userId });
      accountLinked = true;
      if (result.alreadyLinked) accountLinkError = null;
    } catch (error) {
      accountLinkError = error.isOperational ? error.message : "Could not link your account.";
      logger.warn(`[identity] Device linked but account link refused: ${error.message}`);
    }
  }

  return {
    member: toMemberDTO(updated, updated._id),
    mergeSuggestion,
    accountLinked,
    accountLinkError,
  };
};

/**
 * Bind a member to an account, and pull their past group expenses into its
 * ledger (docs/17-MEMBER-IDENTITY.md §6).
 *
 * This is the one place `member.userId` is written. Every path in §6 funnels
 * through it so the refusals below cannot be bypassed by adding a route.
 *
 * ## The two refusals
 *
 * **A member already linked to someone else** is never re-pointed. The draft
 * this design replaces did exactly that, unconditionally — and once a ledger
 * resolves debts through the link, silently re-pointing it moves somebody's
 * money. The guard is in the query (`userId: null`), so two requests racing to
 * claim the same member cannot both win.
 *
 * **An account already holding a different member in this group** is refused
 * too. One person with two members in one group is either two identities that
 * want merging or a mistake, and the app already has a merge flow that a human
 * drives. Picking one automatically would silently orphan the other's history.
 *
 * Re-linking to the *same* account succeeds quietly: it is the natural result of
 * tapping the offer twice, and an error there would be theatre.
 */
const linkAccount = async ({ group, member, userId }) => {
  if (!userId) {
    throw new BadRequestError("Sign in first", ERROR_CODES.UNAUTHENTICATED);
  }

  if (member.userId && String(member.userId) === String(userId)) {
    return { member: toMemberDTO(member, member._id), alreadyLinked: true, backfill: null };
  }

  if (member.userId) {
    throw new ConflictError(
      `${member.name} is already linked to another account. Sign in as that account, or unlink it there first.`,
      ERROR_CODES.MEMBER_ALREADY_LINKED
    );
  }

  const existing = await memberRepository.findByUserId(group._id, userId);
  if (existing && String(existing._id) !== String(member._id)) {
    throw new ConflictError(
      `Your account is already "${existing.name}" in this group. If both are you, merge them first — then link the one that remains.`,
      ERROR_CODES.ACCOUNT_ALREADY_IN_GROUP
    );
  }

  const updated = await memberRepository.linkUser(group._id, member._id, userId);

  // Lost the race: something bound this member between the read and the write.
  if (!updated) {
    throw new ConflictError(
      `${member.name} was just linked to another account.`,
      ERROR_CODES.MEMBER_ALREADY_LINKED
    );
  }

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.ACCOUNT_LINKED,
    actor: updated,
    message: `${updated.name} linked an account`,
    metadata: { memberId: String(updated._id) },
  });

  /**
   * The backfill is the reason anyone does this: the expenses added before
   * signing in are exactly the ones missing from the ledger.
   *
   * Not awaited. It is bounded and usually small, but it is still a write per
   * expense, and the person is waiting on a button — the same reasoning that
   * keeps push dispatch off `activityService.record`'s caller. The ledger is
   * invalidated on the client after this returns, so the rows appear on the next
   * read either way.
   */
  ledgerMirrorService
    .backfillForMember(updated, userId)
    .then((result) => {
      if (result.written > 0) {
        logger.info(
          `[identity] Backfilled ${result.written} expense(s) into the ledger for ${updated.name}`
        );
      }
    })
    .catch((err) => logger.warn(`[identity] Backfill after linking failed: ${err.message}`));

  return { member: toMemberDTO(updated, updated._id), alreadyLinked: false };
};

/**
 * Release the link, from the account that holds it.
 *
 * Scoped to that account by the query, so holding the invite link is not enough
 * to detach someone else's account from their member. Mirrored ledger rows are
 * deliberately left alone: they are the person's own record of their own
 * spending, and deleting financial history as a side effect of unlinking is not
 * a decision this function gets to make.
 */
const unlinkAccount = async ({ group, member, userId }) => {
  const updated = await memberRepository.unlinkUser(group._id, member._id, userId);

  if (!updated) {
    throw new ForbiddenError(
      "That member is not linked to your account.",
      ERROR_CODES.MEMBER_ALREADY_LINKED
    );
  }

  return { member: toMemberDTO(updated, updated._id) };
};

/**
 * Whether to offer the link, for the member this browser already is (§6.1).
 *
 * Deliberately an offer and not an action: the server can see that this browser
 * is Rahul and that someone is signed in, but "this browser is Rahul" is exactly
 * the inference `resolveOwner` refuses to make on its own — a shared laptop
 * makes it wrong. The confirmation is what supplies the missing fact, and only
 * the person at the keyboard has it.
 */
const accountLinkStatus = async ({ group, actor, userId }) => {
  if (!actor) return { linkable: false, reason: "NOT_A_MEMBER" };
  if (!userId) return { linkable: false, reason: "SIGNED_OUT" };

  if (actor.userId) {
    return {
      linkable: false,
      reason: String(actor.userId) === String(userId) ? "LINKED_TO_YOU" : "LINKED_ELSEWHERE",
      memberName: actor.name,
    };
  }

  const existing = await memberRepository.findByUserId(group._id, userId);
  if (existing) {
    return {
      linkable: false,
      reason: "ACCOUNT_ALREADY_IN_GROUP",
      memberName: actor.name,
      heldName: existing.name,
    };
  }

  return { linkable: true, reason: "OFFER", memberId: String(actor._id), memberName: actor.name };
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

/* ------------------------------ Payment address --------------------------- */

/**
 * Set or clear this member's UPI id (docs/16-TODO.md §2.4).
 *
 * ## Why only the member themselves, when the creator may rename anyone
 *
 * Renaming somebody is a label the group agrees on, and the creator doing it for
 * a flatmate who never opened the link is the feature working as intended. A
 * payment address is not a label — it is a claim about the outside world, and one
 * person putting a bank handle on another person's row is precisely the abuse
 * this feature could otherwise enable. `isCreator` grants nothing here, and that
 * asymmetry is deliberate rather than an oversight.
 *
 * The practical consequence is worth stating: a member who has never opened the
 * link cannot have a UPI id, and cannot be given one. Their transfer row keeps
 * the behaviour it has today, which is exactly what §2.4 asks for — "a member
 * with no UPI id sees today's behaviour with no empty state".
 *
 * ## Why this does not record an activity
 *
 * Every other member write funnels through `activityService.record`, which is
 * also what bumps the cache. This one deliberately does not, because `record`
 * fans out a push notification to every device in the group and awards reward
 * points. Waking five people's phones to tell them somebody edited their own
 * payment details is noise at best; at worst it broadcasts a change to a personal
 * financial identifier into a shared feed that anyone holding the invite link can
 * read. The group learns about it the way it should — a Pay button appears on the
 * rows where it is useful.
 *
 * The cost of stepping outside that funnel is that the cache bump has to be made
 * by hand, which is the failure mode cacheService.js warns about. It is the line
 * below, and it is why `listMembers` does not serve a stale row for five minutes
 * after somebody adds an address.
 */
const setUpiId = async ({ group, actor, memberId, upiId }) => {
  const member = await memberRepository.findById(group._id, memberId);

  if (!member || !member.isActive) {
    throw new NotFoundError("Member not found", ERROR_CODES.MEMBER_NOT_FOUND);
  }

  if (String(member._id) !== String(actor._id)) {
    throw new ForbiddenError(
      "You can only add a UPI id to your own name",
      ERROR_CODES.CREATOR_ONLY
    );
  }

  /**
   * `upiId: null` clears it. The validator already normalised and checked
   * anything non-null, so this is the last place either shape can arrive and
   * neither needs re-parsing.
   */
  const updated = await memberRepository.updateById(group._id, member._id, {
    $set: { upiId: upiId || null },
  });

  // Not awaited — a cache that fails to clear must never fail the write.
  cacheService.bumpGroup(group._id);

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

/**
 * Folds one member's entire history into another and retires the first.
 *
 * This is the repair for groups that already contain the same person several times
 * over — the state a single `deviceId` per member used to produce. It moves money
 * nowhere: every share, payer and settlement reference is rewritten, totals are
 * asserted unchanged, and because balances are derived rather than stored they are
 * simply correct on the next read.
 */
const mergeMembers = async ({ group, actor, sourceId, targetId }) => {
  if (String(sourceId) === String(targetId)) {
    throw new BadRequestError("Pick two different members to merge", ERROR_CODES.INVALID_MERGE);
  }

  const [source, target] = await Promise.all([
    memberRepository.findById(group._id, sourceId),
    memberRepository.findById(group._id, targetId),
  ]);

  if (!source || !target) {
    throw new NotFoundError("Member not found", ERROR_CODES.MEMBER_NOT_FOUND);
  }

  if (!target.isActive) {
    throw new ConflictError(
      `${target.name} has been removed from this group — merge into an active member instead`,
      ERROR_CODES.INVALID_MERGE
    );
  }

  if (source.isCreator) {
    throw new ConflictError(
      `${source.name} created this group, so it has to be the one kept. Merge the other way round.`,
      ERROR_CODES.INVALID_MERGE
    );
  }

  // The creator moderates; otherwise you may only merge an identity that is your
  // own, which is the case this exists for.
  const actorId = String(actor._id);
  const isOwnIdentity = actorId === String(source._id) || actorId === String(target._id);

  if (!actor.isCreator && !isOwnIdentity) {
    throw new ForbiddenError(
      "Only the group creator can merge other people's identities",
      ERROR_CODES.CREATOR_ONLY
    );
  }

  const [expenses, settlements] = await Promise.all([
    expenseRepository.listAllInvolvingMember(group._id, source._id),
    settlementRepository.listAllInvolvingMember(group._id, source._id),
  ]);

  const removedSettlements = [];
  let expensesReassigned = 0;
  let expensesResplit = 0;
  let settlementsReassigned = 0;

  await withTransaction(async (session) => {
    for (const expense of expenses) {
      const { changed, resplit, patch } = remapExpense(expense, source._id, target._id);
      if (!changed) continue;

      // Throws rather than writing: an expense whose shares stopped adding up
      // would be far worse than a merge that failed.
      assertExpenseIntact(expense, patch);

      await expenseRepository.applyMergePatch(group._id, expense._id, patch, session);
      expensesReassigned += 1;
      // Both identities were participants, so this expense was over-divided and
      // everyone's share in it just changed. Worth telling the user about.
      if (resplit) expensesResplit += 1;
    }

    for (const settlement of settlements) {
      const result = remapSettlement(settlement, source._id, target._id);

      if (result.action === "drop") {
        removedSettlements.push({
          amountMinor: settlement.amountMinor,
          settledAt: settlement.settledAt,
        });
        await settlementRepository.deleteById(group._id, settlement._id, session);
      } else if (result.action === "update") {
        await settlementRepository.applyMergePatch(group._id, settlement._id, result.patch, session);
        settlementsReassigned += 1;
      }
    }

    // The devices come across, so whoever was signed in as the duplicate stays
    // signed in — as the right person now.
    for (const deviceId of devicesOf(source)) {
      await memberRepository.addDevice(group._id, target._id, deviceId);
    }

    await memberRepository.updateById(group._id, source._id, {
      $set: {
        isActive: false,
        deviceIds: [],
        deviceId: null,
        linkCode: { hash: null, expiresAt: null },
      },
    });
  });

  await groupRepository.incrementMemberCount(group._id, -1);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.MEMBER_MERGED,
    actor,
    message: `${actor.name} merged ${source.name} into ${target.name}`,
    metadata: {
      fromMemberId: String(source._id),
      fromName: source.name,
      intoMemberId: String(target._id),
      intoName: target.name,
      expensesReassigned,
      expensesResplit,
      settlementsReassigned,
      // Named individually, with amounts: the timeline has to stay truthful about
      // records that were removed rather than reassigned.
      settlementsRemoved: removedSettlements.map(
        (entry) => `${formatMinor(entry.amountMinor, group.currency)} on ${new Date(entry.settledAt).toISOString().slice(0, 10)}`
      ),
    },
  });

  await groupRepository.touchActivity(group._id);

  const merged = await memberRepository.findById(group._id, target._id);

  return {
    member: toMemberDTO(merged, actor._id),
    expensesReassigned,
    expensesResplit,
    settlementsReassigned,
    settlementsRemoved: removedSettlements.length,
  };
};

/** Name lookup used by the expense/settlement serializers. */
const buildNameMap = async (groupId) => {
  const members = await memberRepository.findByGroup(groupId, { includeInactive: true });
  return new Map(members.map((member) => [String(member._id), member.name]));
};

module.exports = {
  listMembers,
  attachDevice,
  joinGroup,
  claimMember,
  createDeviceLinkCode,
  linkDevice,
  linkAccount,
  unlinkAccount,
  accountLinkStatus,
  mergeMembers,
  addMember,
  renameMember,
  setUpiId,
  removeMember,
  buildNameMap,
};
