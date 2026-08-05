const ledgerRepository = require("../repositories/ledgerRepository");
const { toMinor, assertMinor, formatMinor } = require("../utils/money");
const { buildPage, decodeCursor } = require("../utils/cursor");
const { NotFoundError, BadRequestError, ConflictError } = require("../errors");
const {
  LEDGER_ENTRY_TYPES,
  ERROR_CODES,
  LIMITS,
  DEFAULT_CURRENCY,
} = require("../constants");

/**
 * The personal ledger (docs/08-PERSONAL-LEDGER.md).
 *
 * Two rules govern everything here, and both are inherited rather than invented:
 *
 *  1. **Money is integer minor units, end to end** (docs/05-ALGORITHMS.md §1).
 *     Nothing in this file performs float arithmetic on an amount.
 *  2. **Outstanding is derived, never stored.** A stored total is a total that
 *     can drift from the rows beneath it, and a reconciliation bug in a ledger
 *     about money is indefensible. It is recomputed on every read, exactly as
 *     group balances are.
 */

const DEBT_TYPES = new Set([LEDGER_ENTRY_TYPES.LENT, LEDGER_ENTRY_TYPES.BORROWED]);

/** `principal − Σ repayments`. The only definition of what is still owed. */
const outstandingOf = (entry) => {
  if (entry.type === LEDGER_ENTRY_TYPES.SPEND) return 0;
  const repaid = (entry.repayments || []).reduce((sum, r) => sum + r.amountMinor, 0);
  return entry.amountMinor - repaid;
};

const toEntryDTO = (entry) => ({
  id: String(entry._id),
  type: entry.type,
  amountMinor: entry.amountMinor,
  outstandingMinor: outstandingOf(entry),
  currencyCode: entry.currencyCode,
  description: entry.description,
  counterpartyName: entry.counterpartyName,
  category: entry.category || null,
  occurredAt: entry.occurredAt,
  dueAt: entry.dueAt,
  settledAt: entry.settledAt,
  notes: entry.notes,
  version: entry.version,
  repayments: (entry.repayments || []).map((r) => ({
    id: String(r._id),
    amountMinor: r.amountMinor,
    paidAt: r.paidAt,
    note: r.note,
  })),
});

/**
 * Fetch this user's ledger, creating it on first use.
 *
 * Created lazily rather than at sign-up: an account that never opens the ledger
 * should not leave an empty row behind, and the first read is a perfectly good
 * moment to make one.
 */
const getOrCreate = async (userId) => {
  const existing = await ledgerRepository.findByUser(userId);
  if (existing) return existing;

  try {
    return await ledgerRepository.createForUser(userId, DEFAULT_CURRENCY);
  } catch (err) {
    // Two concurrent first-reads race on the unique index; the loser re-reads.
    if (err?.code === 11000) return ledgerRepository.findByUser(userId);
    throw err;
  }
};

const startOfMonth = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), 1);

const getSummary = async (userId) => {
  const ledger = await getOrCreate(userId);

  const [totals, categories] = await Promise.all([
    ledgerRepository.totals(ledger._id, { spendSince: startOfMonth() }),
    ledgerRepository.spendByCategory(ledger._id, startOfMonth()),
  ]);

  return {
    ledger: { id: String(ledger._id), currency: ledger.currency },
    /**
     * Deliberately three separate figures, never netted into one.
     *
     * "You are up ₹400" is false comfort when it means someone owes you ₹1,400
     * and you owe someone else ₹1,000 — those are two different conversations
     * with two different people, and one of them may never pay
     * (docs/08-PERSONAL-LEDGER.md §5).
     */
    totals,
    spendByCategory: categories.map((row) => ({
      category: row._id || "OTHER",
      totalMinor: row.totalMinor,
      count: row.count,
    })),
  };
};

const listEntries = async (userId, { cursor, limit = LIMITS.DEFAULT_PAGE_SIZE, type, settled } = {}) => {
  const ledger = await getOrCreate(userId);

  const rows = await ledgerRepository.listEntries(ledger._id, {
    cursor: decodeCursor(cursor),
    limit,
    type,
    settled,
  });

  const page = buildPage(rows, limit);
  return {
    items: page.items.map(toEntryDTO),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
};

/**
 * A `SPEND` has no counterparty and no due date; a debt has both available. These
 * are stripped rather than rejected, so a client that sends a stale field gets a
 * clean record instead of a validation error about something the user cannot see.
 */
const normalizeForType = (type, dto) => {
  if (type === LEDGER_ENTRY_TYPES.SPEND) {
    return { counterpartyName: "", dueAt: null };
  }
  return {
    counterpartyName: dto.counterpartyName?.trim() || "",
    dueAt: dto.dueAt || null,
  };
};

const createEntry = async (userId, dto) => {
  const ledger = await getOrCreate(userId);
  const type = dto.type;

  const amountMinor = toMinor(dto.amount, ledger.currency);
  assertMinor(amountMinor, "Amount");

  const entry = await ledgerRepository.createEntry({
    ledgerId: ledger._id,
    type,
    amountMinor,
    currencyCode: ledger.currency,
    description: dto.description,
    category: dto.category || "",
    occurredAt: dto.occurredAt || new Date(),
    notes: dto.notes || "",
    version: 0,
    ...normalizeForType(type, dto),
  });

  await ledgerRepository.touchActivity(ledger._id);
  return toEntryDTO(entry);
};

const updateEntry = async (userId, entryId, dto) => {
  const ledger = await getOrCreate(userId);
  const entry = await ledgerRepository.findEntry(ledger._id, entryId);
  if (!entry) throw new NotFoundError("Entry not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  /**
   * Optimistic concurrency, as expenses have. Two tabs open on the same entry is
   * an ordinary thing to do, and the second save should be told it is stale
   * rather than silently overwrite the first.
   */
  if (entry.version !== dto.version) {
    throw new ConflictError(
      "This entry changed since you opened it. Reload and try again.",
      ERROR_CODES.VERSION_CONFLICT
    );
  }

  if (dto.amount !== undefined) {
    const amountMinor = toMinor(dto.amount, ledger.currency);
    /**
     * The principal cannot drop below what has already been repaid — that would
     * make the outstanding balance negative, which is not a state the ledger has
     * a meaning for.
     */
    const repaid = entry.amountMinor - outstandingOf(entry);
    if (amountMinor < repaid) {
      throw new BadRequestError(
        "That is less than what has already been repaid against this entry.",
        ERROR_CODES.REPAYMENT_EXCEEDS_PRINCIPAL
      );
    }
    entry.amountMinor = amountMinor;
  }

  if (dto.description !== undefined) entry.description = dto.description;
  if (dto.category !== undefined) entry.category = dto.category || "";
  if (dto.occurredAt !== undefined) entry.occurredAt = dto.occurredAt;
  if (dto.notes !== undefined) entry.notes = dto.notes;

  if (dto.counterpartyName !== undefined && DEBT_TYPES.has(entry.type)) {
    entry.counterpartyName = dto.counterpartyName.trim();
  }
  if (dto.dueAt !== undefined && DEBT_TYPES.has(entry.type)) {
    entry.dueAt = dto.dueAt;
  }

  // The principal may have changed; re-derive whether this is now settled.
  entry.settledAt = outstandingOf(entry) <= 0 && DEBT_TYPES.has(entry.type) ? entry.settledAt || new Date() : null;
  entry.version += 1;

  await entry.save();
  await ledgerRepository.touchActivity(ledger._id);
  return toEntryDTO(entry);
};

const deleteEntry = async (userId, entryId) => {
  const ledger = await getOrCreate(userId);
  const removed = await ledgerRepository.softDeleteEntry(ledger._id, entryId);
  if (!removed) throw new NotFoundError("Entry not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  await ledgerRepository.touchActivity(ledger._id);
  return { id: String(removed._id), deleted: true };
};

/**
 * Record money coming back (or going out) against a debt.
 *
 * The overshoot is **rejected, not clamped**. Clamping would silently absorb a
 * typo — someone entering 4000 instead of 400 would see the loan close and never
 * learn why the numbers stopped making sense.
 */
const addRepayment = async (userId, entryId, dto) => {
  const ledger = await getOrCreate(userId);
  const entry = await ledgerRepository.findEntry(ledger._id, entryId);
  if (!entry) throw new NotFoundError("Entry not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  if (!DEBT_TYPES.has(entry.type)) {
    throw new BadRequestError(
      "Only money lent or borrowed can be repaid — a spend is already gone.",
      ERROR_CODES.NOT_A_DEBT
    );
  }

  const amountMinor = toMinor(dto.amount, entry.currencyCode);
  assertMinor(amountMinor, "Repayment");

  const outstanding = outstandingOf(entry);
  if (amountMinor > outstanding) {
    throw new BadRequestError(
      `That is more than the ${formatMinor(outstanding, entry.currencyCode)} still outstanding.`,
      ERROR_CODES.REPAYMENT_EXCEEDS_PRINCIPAL
    );
  }

  entry.repayments.push({
    amountMinor,
    paidAt: dto.paidAt || new Date(),
    note: dto.note || "",
  });

  // Settled is derived from the rows, then recorded — never set independently.
  if (outstandingOf(entry) === 0) entry.settledAt = new Date();
  entry.version += 1;

  await entry.save();
  await ledgerRepository.touchActivity(ledger._id);
  return toEntryDTO(entry);
};

/**
 * Undo a repayment. This is also how a settled entry is reopened — by removing
 * the row that closed it, so the flag can never disagree with the arithmetic.
 */
const removeRepayment = async (userId, entryId, repaymentId) => {
  const ledger = await getOrCreate(userId);
  const entry = await ledgerRepository.findEntry(ledger._id, entryId);
  if (!entry) throw new NotFoundError("Entry not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  const repayment = entry.repayments.id(repaymentId);
  if (!repayment) throw new NotFoundError("Repayment not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  repayment.deleteOne();
  if (outstandingOf(entry) > 0) entry.settledAt = null;
  entry.version += 1;

  await entry.save();
  await ledgerRepository.touchActivity(ledger._id);
  return toEntryDTO(entry);
};

module.exports = {
  getOrCreate,
  getSummary,
  listEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  addRepayment,
  removeRepayment,
  outstandingOf,
  toEntryDTO,
};
