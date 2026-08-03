const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const expenseRepository = require("../repositories/expenseRepository");
const memberService = require("./memberService");
const activityService = require("./activityService");
const {
  calculateShares,
  assertSharesBalance,
  normalizeSplitValues,
} = require("../utils/splitCalculator");
const { toMinor, formatMinor } = require("../utils/money");
const { toExpenseDTO } = require("../serializers");
const { buildPage } = require("../utils/cursor");
const { ACTIVITY_TYPES, LIMITS, SPLIT_TYPES, ERROR_CODES } = require("../constants");
const { BadRequestError, NotFoundError, ConflictError, ForbiddenError } = require("../errors");

/**
 * Changing an expense is restricted to the member who recorded it, plus the group
 * creator acting as moderator.
 *
 * Without this rule, holding the invite link is permission to rewrite anyone's
 * numbers: one member logs ₹100 of groceries, another quietly makes it ₹70, and
 * both their balances move. The activity log would record it, but only after the
 * fact — and a balance the payer never agreed to is exactly the disagreement this
 * app exists to prevent.
 *
 * The creator keeps an override because the author may have lost their device or
 * left the group, and an expense nobody can correct is its own kind of broken.
 */
const assertCanModify = (expense, actor) => {
  const isAuthor = String(expense.createdByMemberId) === String(actor._id);

  if (!isAuthor && !actor.isCreator) {
    throw new ForbiddenError(
      "Only the member who added this expense can change it. Ask them, or ask the group creator.",
      ERROR_CODES.EXPENSE_OWNER_ONLY
    );
  }
};

/**
 * Validates that the payer and every participant is a live member of this group.
 * Doing it here (rather than trusting ids from the client) is what keeps shares
 * pointing at people who actually exist.
 */
const resolveParticipants = async (group, paidBy, participantIds) => {
  const uniqueIds = [...new Set(participantIds.map(String))];

  if (uniqueIds.length === 0) {
    throw new BadRequestError("Select at least one participant", ERROR_CODES.INVALID_PARTICIPANTS);
  }

  if (uniqueIds.length > LIMITS.MAX_PARTICIPANTS) {
    throw new BadRequestError(
      `An expense can have at most ${LIMITS.MAX_PARTICIPANTS} participants`,
      ERROR_CODES.INVALID_PARTICIPANTS
    );
  }

  const lookupIds = [...new Set([...uniqueIds, String(paidBy)])];
  const members = await memberRepository.findActiveByIds(group._id, lookupIds);
  const foundIds = new Set(members.map((member) => String(member._id)));

  if (!foundIds.has(String(paidBy))) {
    throw new BadRequestError("The payer is not an active member of this group", ERROR_CODES.INVALID_PARTICIPANTS);
  }

  const unknown = uniqueIds.filter((memberId) => !foundIds.has(memberId));
  if (unknown.length > 0) {
    throw new BadRequestError(
      "One or more participants are not active members of this group",
      ERROR_CODES.INVALID_PARTICIPANTS
    );
  }

  return uniqueIds;
};

/** Stored split values → the plain `[{ memberId, value }]` the calculator expects. */
const storedSplitValues = (expense) =>
  (expense.splitValues || []).map((entry) => ({
    memberId: String(entry.memberId),
    value: entry.value,
  }));

const createExpense = async ({ group, actor, dto }) => {
  // Idempotency: a retried or double-tapped submit returns the original expense
  // rather than charging the group twice.
  if (dto.clientRequestId) {
    const existing = await expenseRepository.findByClientRequestId(group._id, dto.clientRequestId);
    if (existing) {
      const nameMap = await memberService.buildNameMap(group._id);
      return { expense: toExpenseDTO(existing, nameMap, group.currency), created: false };
    }
  }

  const amountMinor = toMinor(dto.amount, group.currency);
  const participantIds = await resolveParticipants(group, dto.paidBy, dto.participantIds);
  const splitType = dto.splitType || SPLIT_TYPES.EQUAL;

  const splitValues = normalizeSplitValues({
    splitType,
    splitValues: dto.splitValues,
    currency: group.currency,
  });

  const shares = calculateShares({
    splitType,
    amountMinor,
    participantIds,
    splitValues,
    currency: group.currency,
  });

  // Belt and braces: the calculator already asserts this, and the model asserts it
  // again on save. An unbalanced expense corrupts every balance computed after it.
  assertSharesBalance(shares, amountMinor);

  const expense = await expenseRepository.create({
    groupId: group._id,
    description: dto.description,
    amountMinor,
    currencyCode: group.currency,
    paidBy: dto.paidBy,
    splitType,
    shares,
    splitValues,
    expenseDate: dto.expenseDate || new Date(),
    notes: dto.notes || "",
    createdByMemberId: actor._id,
    clientRequestId: dto.clientRequestId || null,
    version: 0,
  });

  const nameMap = await memberService.buildNameMap(group._id);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.EXPENSE_ADDED,
    actor,
    message: `${actor.name} added "${expense.description}" — ${formatMinor(amountMinor, group.currency)}`,
    metadata: {
      expenseId: String(expense._id),
      amountMinor,
      paidByName: nameMap.get(String(expense.paidBy)) || "Unknown",
      participantCount: shares.length,
      splitType,
    },
  });

  await groupRepository.touchActivity(group._id);

  return { expense: toExpenseDTO(expense, nameMap, group.currency), created: true };
};

const updateExpense = async ({ group, actor, expenseId, dto }) => {
  const existing = await expenseRepository.findById(group._id, expenseId);

  if (!existing) {
    throw new NotFoundError("Expense not found", ERROR_CODES.EXPENSE_NOT_FOUND);
  }

  assertCanModify(existing, actor);

  if (existing.version !== dto.version) {
    throw new ConflictError(
      "This expense was changed by someone else. Reload and try again.",
      ERROR_CODES.VERSION_CONFLICT,
      [{ field: "version", message: `currentVersion: ${existing.version}` }]
    );
  }

  const amountMinor =
    dto.amount !== undefined ? toMinor(dto.amount, group.currency) : existing.amountMinor;

  const paidBy = dto.paidBy || existing.paidBy;
  const participantIds =
    dto.participantIds ?? existing.shares.map((share) => String(share.memberId));

  const resolvedIds = await resolveParticipants(group, paidBy, participantIds);
  const splitType = dto.splitType || existing.splitType;

  /**
   * An edit that leaves the split alone reuses the stored values, so changing only
   * the amount re-derives the same 60/40 rather than demanding the user retype it.
   * If the split type changed, or the client sent new values, they are re-normalized.
   * Stored values that no longer cover the participant set are rejected by the
   * calculator — which is the right answer: adding someone to a percentage split
   * genuinely does require deciding their percentage.
   */
  const splitValues =
    dto.splitValues === undefined && splitType === existing.splitType
      ? storedSplitValues(existing)
      : normalizeSplitValues({
          splitType,
          splitValues: dto.splitValues,
          currency: group.currency,
        });

  const shares = calculateShares({
    splitType,
    amountMinor,
    participantIds: resolvedIds,
    splitValues,
    currency: group.currency,
  });

  assertSharesBalance(shares, amountMinor);

  const before = {
    description: existing.description,
    amountMinor: existing.amountMinor,
    participantCount: existing.shares.length,
  };

  const updated = await expenseRepository.updateById(
    group._id,
    expenseId,
    {
      $set: {
        description: dto.description ?? existing.description,
        amountMinor,
        paidBy,
        splitType,
        shares,
        splitValues,
        expenseDate: dto.expenseDate || existing.expenseDate,
        notes: dto.notes ?? existing.notes,
      },
      $inc: { version: 1 },
    },
    dto.version
  );

  // Lost the race between the read and the write — same failure mode as a stale
  // version, so report it the same way.
  if (!updated) {
    throw new ConflictError(
      "This expense was changed by someone else. Reload and try again.",
      ERROR_CODES.VERSION_CONFLICT
    );
  }

  const nameMap = await memberService.buildNameMap(group._id);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.EXPENSE_UPDATED,
    actor,
    message: `${actor.name} updated "${updated.description}"`,
    metadata: {
      expenseId: String(updated._id),
      before,
      after: {
        description: updated.description,
        amountMinor: updated.amountMinor,
        participantCount: updated.shares.length,
      },
    },
  });

  await groupRepository.touchActivity(group._id);

  return toExpenseDTO(updated, nameMap, group.currency);
};

/** Soft delete — dropped from balances immediately, retained in the timeline. */
const deleteExpense = async ({ group, actor, expenseId }) => {
  // Loaded before deleting rather than deleting conditionally: the caller needs to
  // be told "you may not" separately from "it isn't there".
  const existing = await expenseRepository.findById(group._id, expenseId);

  if (!existing) {
    throw new NotFoundError("Expense not found", ERROR_CODES.EXPENSE_NOT_FOUND);
  }

  assertCanModify(existing, actor);

  const deleted = await expenseRepository.softDelete(group._id, expenseId, actor._id);

  if (!deleted) {
    throw new NotFoundError("Expense not found", ERROR_CODES.EXPENSE_NOT_FOUND);
  }

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.EXPENSE_DELETED,
    actor,
    message: `${actor.name} deleted "${deleted.description}" — ${formatMinor(deleted.amountMinor, group.currency)}`,
    metadata: {
      expenseId: String(deleted._id),
      description: deleted.description,
      amountMinor: deleted.amountMinor,
    },
  });

  await groupRepository.touchActivity(group._id);

  return true;
};

const listExpenses = async (group, { cursor, limit = LIMITS.DEFAULT_PAGE_SIZE, memberId } = {}) => {
  const [rows, nameMap] = await Promise.all([
    expenseRepository.listByGroup(group._id, { cursor, limit, memberId }),
    memberService.buildNameMap(group._id),
  ]);

  const page = buildPage(rows, limit);

  return {
    items: page.items.map((expense) => toExpenseDTO(expense, nameMap, group.currency)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
};

const getExpense = async (group, expenseId) => {
  const expense = await expenseRepository.findById(group._id, expenseId);

  if (!expense) {
    throw new NotFoundError("Expense not found", ERROR_CODES.EXPENSE_NOT_FOUND);
  }

  const nameMap = await memberService.buildNameMap(group._id);
  return toExpenseDTO(expense, nameMap, group.currency);
};

module.exports = {
  createExpense,
  updateExpense,
  deleteExpense,
  listExpenses,
  getExpense,
  // Exported for tests: it is the rule that decides whose numbers can be changed.
  assertCanModify,
};
