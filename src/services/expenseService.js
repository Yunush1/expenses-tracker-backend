const { withTransaction } = require("../config/db");
const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const expenseRepository = require("../repositories/expenseRepository");
const memberService = require("./memberService");
const activityService = require("./activityService");
const ledgerMirrorService = require("./ledgerMirrorService");
const {
  calculateShares,
  assertSharesBalance,
  normalizeSplitValues,
} = require("../utils/splitCalculator");
const { toMinor, formatMinor } = require("../utils/money");
const { inferCategory } = require("../utils/inferCategory");
const { toExpenseDTO } = require("../serializers");
const { buildPage, buildKeyPage } = require("../utils/cursor");
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
    /**
     * Inferred from the description at write time, not guessed at read time.
     *
     * It has to be *stored* for filtering to work: a category derived in the
     * browser cannot be a `WHERE` clause, so "show me food" would either scan
     * every expense or silently filter one page. Storing it also means the
     * personal-ledger mirror inherits it rather than re-deriving the same answer.
     *
     * An explicit category from the client still wins, for the day a picker
     * exists (docs/08-PERSONAL-LEDGER.md §12).
     */
    category: inferCategory(dto.description, dto.category),
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

  /**
   * Reflect the creator's own share into their personal ledger, when they have an
   * account. Unawaited: this is a convenience for people who signed in, and it
   * must not add latency or a failure mode to adding an expense — which works
   * with no account at all (docs/08-PERSONAL-LEDGER.md §12).
   */
  ledgerMirrorService.mirrorExpense({ group, actor, expense }).catch(() => {});

  return { expense: toExpenseDTO(expense, nameMap, group.currency), created: true };
};

/**
 * Several expenses in one submission — a shop run with four lines, entered once
 * with one payer instead of four times over.
 *
 * Everything is validated and every split computed **before the first write**. The
 * failures that actually happen here are input failures — a removed member, an
 * amount with three decimals, percentages that miss 100 — and discovering the
 * fourth one after three rows are already in the ledger would leave the user to
 * work out which half landed. On a replica set the writes are additionally wrapped
 * in a transaction; on a standalone mongod, validate-first is the guarantee.
 */
const createExpenseBatch = async ({ group, actor, dto }) => {
  const { paidBy, expenseDate, items } = dto;
  const date = expenseDate || new Date();

  const prepared = [];

  for (const item of items) {
    // Sequential rather than Promise.all: the first bad row should report itself,
    // and a batch is at most 20 items.
    // eslint-disable-next-line no-await-in-loop
    const existing = item.clientRequestId
      ? await expenseRepository.findByClientRequestId(group._id, item.clientRequestId)
      : null;

    // A retried batch must not double-charge. Items already recorded are carried
    // through untouched so the response still describes the whole submission.
    if (existing) {
      prepared.push({ existing });
      continue;
    }

    const amountMinor = toMinor(item.amount, group.currency);
    // eslint-disable-next-line no-await-in-loop
    const participantIds = await resolveParticipants(group, paidBy, item.participantIds);
    const splitType = item.splitType || SPLIT_TYPES.EQUAL;

    const splitValues = normalizeSplitValues({
      splitType,
      splitValues: item.splitValues,
      currency: group.currency,
    });

    const shares = calculateShares({
      splitType,
      amountMinor,
      participantIds,
      splitValues,
      currency: group.currency,
    });

    assertSharesBalance(shares, amountMinor);

    prepared.push({
      doc: {
        groupId: group._id,
        description: item.description,
        category: inferCategory(item.description, item.category),
        amountMinor,
        currencyCode: group.currency,
        paidBy,
        splitType,
        shares,
        splitValues,
        expenseDate: date,
        notes: item.notes || "",
        /**
         * The receipt these lines were read off, on every one of them.
         *
         * Copied rather than shared, because each line is a separate expense that
         * can be edited, moved or deleted on its own — and the person looking at
         * the odd one out six weeks later is exactly who needs the photograph. The
         * field has been reserved for this since docs/02-HLD.md §9.
         */
        attachments: dto.attachments || [],
        createdByMemberId: actor._id,
        clientRequestId: item.clientRequestId || null,
        version: 0,
      },
    });
  }

  const written = await withTransaction(async (session) => {
    const created = [];
    for (const entry of prepared) {
      if (entry.existing) {
        created.push(entry.existing);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- ordered, and bounded at 20
      created.push(await expenseRepository.create(entry.doc, session));
    }
    return created;
  });

  const nameMap = await memberService.buildNameMap(group._id);
  const newCount = prepared.filter((entry) => !entry.existing).length;
  const totalMinor = written.reduce((sum, expense) => sum + expense.amountMinor, 0);

  // One entry, not one per item: a five-line shop run is a single thing the user
  // did, and five near-identical rows would bury the rest of the timeline.
  if (newCount > 0) {
    await activityService.record({
      groupId: group._id,
      type: ACTIVITY_TYPES.EXPENSE_ADDED,
      actor,
      message: `${actor.name} added ${newCount} item${newCount === 1 ? "" : "s"} — ${formatMinor(
        totalMinor,
        group.currency
      )}`,
      metadata: {
        itemCount: newCount,
        totalMinor,
        paidByName: nameMap.get(String(paidBy)) || "Unknown",
        descriptions: written.map((expense) => expense.description).slice(0, 10),
      },
    });

    await groupRepository.touchActivity(group._id);

    /**
     * One mirror per line, not one for the batch: a shop run is five separate
     * things bought, and collapsing them into a single personal entry would lose
     * exactly the detail the ledger exists to keep. Sequential and unawaited —
     * bounded at 20, and never allowed to delay the response.
     */
    Promise.all(
      written.map((expense) => ledgerMirrorService.mirrorExpense({ group, actor, expense }))
    ).catch(() => {});
  }

  return {
    expenses: written.map((expense) => toExpenseDTO(expense, nameMap, group.currency)),
    created: newCount,
    totalMinor,
  };
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
        /**
         * A category the client did not mention is left alone.
         *
         * This used to re-infer on every edit, which was right while nothing could
         * set the field by hand. Now that the form has a picker, re-inferring
         * would quietly undo somebody's correction — file the airport Uber under
         * OFFICE, fix a typo in the description a week later, and it silently
         * becomes TRAVEL again.
         *
         * So: absent means keep, `null` means "back to automatic", and a value
         * wins outright. Inference still fills the gap for the rows written before
         * any of this existed.
         */
        category:
          dto.category === undefined
            ? existing.category || inferCategory(dto.description ?? existing.description)
            : inferCategory(dto.description ?? existing.description, dto.category),
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

  /**
   * Keep any mirror in step. Note this recomputes the *share*, not the total: an
   * edit that only adds a participant leaves the amount untouched while changing
   * what each person actually spent, and a mirror that ignored that would drift
   * quietly and permanently.
   */
  ledgerMirrorService.syncMirror(updated).catch(() => {});

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

  // The personal copy goes with it — soft-deleted, so the history is still there.
  ledgerMirrorService.removeMirror(deleted._id).catch(() => {});

  return true;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The months and years this group has spending in.
 *
 * ## Why this is a view and not a new kind of thing
 *
 * A flatshare runs for years in one group, and the ask is to stop creating a new
 * group every month. Expenses already carry a date, so "August" is a *filter*,
 * not an entity — no cycle to open, close, roll over or accidentally leave two of
 * open at once. Nothing about the money model changes.
 *
 * **What deliberately does not become period-scoped: balances and settle-up.**
 * A settlement in September routinely pays off August's dinner, so "who owes whom
 * in August" computed from August's rows alone would ignore the payment that
 * cleared it — and show a debt somebody has already settled. Someone would pay
 * twice. Spending totals split by month cleanly; debts do not, because a debt is
 * a running position, not a monthly one. See docs/14-PERIODS.md §3.
 */
const listPeriods = async (group) => {
  const rows = await expenseRepository.periods(group._id);

  const months = rows.map((row) => ({
    key: `${row._id.year}-${String(row._id.month).padStart(2, "0")}`,
    year: row._id.year,
    month: row._id.month,
    label: `${MONTHS[row._id.month - 1]} ${row._id.year}`,
    shortLabel: `${MONTHS[row._id.month - 1].slice(0, 3)}`,
    totalMinor: row.totalMinor,
    count: row.count,
  }));

  // Rolled up here rather than in a second aggregation — the months already carry
  // everything a year needs.
  const byYear = new Map();
  for (const month of months) {
    const current = byYear.get(month.year) || { totalMinor: 0, count: 0 };
    byYear.set(month.year, {
      totalMinor: current.totalMinor + month.totalMinor,
      count: current.count + month.count,
    });
  }

  const years = [...byYear.entries()]
    .map(([year, totals]) => ({ key: String(year), year, label: String(year), ...totals }))
    .sort((a, b) => b.year - a.year);

  return {
    months,
    years,
    /** So the header can say "all time" without a second request. */
    total: {
      totalMinor: months.reduce((sum, month) => sum + month.totalMinor, 0),
      count: months.reduce((sum, month) => sum + month.count, 0),
    },
  };
};

const listExpenses = async (group, options = {}) => {
  const { limit = LIMITS.DEFAULT_PAGE_SIZE, dateField = "expenseDate", sort = "date_desc" } = options;

  const [rows, nameMap] = await Promise.all([
    expenseRepository.listByGroup(group._id, { ...options, limit, dateField, sort }),
    memberService.buildNameMap(group._id),
  ]);

  // The cursor has to encode whatever the list is sorted by, or "load more"
  // silently drops rows — see utils/cursor.js.
  const [sortKey] = String(sort).split("_");
  const page = buildKeyPage(rows, limit, sortKey === "amount" ? "amountMinor" : dateField);

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
  createExpenseBatch,
  updateExpense,
  deleteExpense,
  listExpenses,
  listPeriods,
  getExpense,
  // Exported for tests: it is the rule that decides whose numbers can be changed.
  assertCanModify,
};
