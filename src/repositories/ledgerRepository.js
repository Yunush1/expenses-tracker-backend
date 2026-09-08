const Ledger = require("../models/ledger");
const LedgerEntry = require("../models/ledgerEntry");
const { LEDGER_ENTRY_TYPES } = require("../constants");

/** All ledger queries live here. No business rules — those belong to the service. */

const findByUser = (userId) => Ledger.findOne({ userId });

const createForUser = (userId, currency) => Ledger.create({ userId, currency });

const touchActivity = (ledgerId) =>
  Ledger.updateOne({ _id: ledgerId }, { $set: { lastActivityAt: new Date() } }).catch(() => null);

/**
 * One page of entries, newest first.
 *
 * `_id` breaks ties on `occurredAt` because several entries can share a date —
 * without it the cursor could loop or skip on a boundary, which is the failure
 * the opaque cursor exists to prevent (utils/cursor.js).
 */
const listEntries = (ledgerId, { cursor, limit, type, settled, source } = {}) => {
  const filter = { ledgerId, isDeleted: false };

  if (type) filter.type = type;

  /**
   * Where the row came from — typed here, or mirrored from a group expense.
   *
   * `MANUAL` matches missing as well as `"MANUAL"`: every entry written before
   * the field existed is a manual one, and they must not vanish from the tab that
   * is supposed to show them.
   */
  if (source === "MANUAL") filter.source = { $in: [null, "MANUAL"] };
  else if (source === "GROUP_EXPENSE") filter.source = "GROUP_EXPENSE";

  /**
   * Settlement is a debt concept, so filtering by it scopes to debts.
   *
   * A `SPEND` carries `settledAt: null` because it is money gone, not because it
   * is outstanding — matching on the null alone would file every coffee under
   * "still owed to you", which is both wrong and alarming.
   */
  if (settled !== undefined) {
    filter.settledAt = settled ? { $ne: null } : null;
    if (!type) filter.type = { $in: [LEDGER_ENTRY_TYPES.LENT, LEDGER_ENTRY_TYPES.BORROWED] };
  }

  if (cursor) filter._id = { $lt: cursor };

  return LedgerEntry.find(filter)
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
};

/**
 * Scoped by `ledgerId` as well as `_id`, always.
 *
 * An entry id is a guessable-shaped ObjectId, unlike a 96-bit invite code, so
 * ownership is proven by the query rather than assumed from the path. Finding by
 * `_id` alone and checking afterwards leaves a window where the wrong row has
 * already been read.
 */
const findEntry = (ledgerId, entryId) =>
  LedgerEntry.findOne({ _id: entryId, ledgerId, isDeleted: false });

const createEntry = (payload) => LedgerEntry.create(payload);

const softDeleteEntry = (ledgerId, entryId) =>
  LedgerEntry.findOneAndUpdate(
    { _id: entryId, ledgerId, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date() } },
    { new: true }
  );

/**
 * Money that left the owner's pocket in a window by paying back something
 * *borrowed* — repayments received on money the owner *lent* are the opposite
 * direction (cash coming back in) and never belong here.
 *
 * Kept separate from the `spend` aggregate in `totals()` below because it reads
 * a different field on a different type of row: `repayments.paidAt` on a
 * `BORROWED` entry, not `occurredAt` on a `SPEND` one. A ₹5,000 loan taken in
 * July and paid back ₹2,000 in September is ₹2,000 of real spending in
 * September, even though the entry itself is dated July.
 */
const repaidBorrowedTotal = async (ledgerId, since) => {
  const rows = await LedgerEntry.aggregate([
    { $match: { ledgerId, isDeleted: false, type: LEDGER_ENTRY_TYPES.BORROWED } },
    { $unwind: "$repayments" },
    ...(since ? [{ $match: { "repayments.paidAt": { $gte: since } } }] : []),
    { $group: { _id: null, totalMinor: { $sum: "$repayments.amountMinor" }, count: { $sum: 1 } } },
  ]);
  return rows[0] || { totalMinor: 0, count: 0 };
};

/**
 * The three headline figures, computed in the database rather than by loading
 * every entry — the ledger summary is the most-hit read and must not scale with
 * how long someone has been using it.
 *
 * `spentMinor` is bounded to a window; the debts are not, because an unsettled
 * loan from two years ago is still owed.
 */
const totals = async (ledgerId, { spendSince } = {}) => {
  const [debts, spend, repaid] = await Promise.all([
    LedgerEntry.aggregate([
      {
        $match: {
          ledgerId,
          isDeleted: false,
          settledAt: null,
          type: { $in: [LEDGER_ENTRY_TYPES.LENT, LEDGER_ENTRY_TYPES.BORROWED] },
        },
      },
      {
        $group: {
          _id: "$type",
          // Outstanding is derived here too — principal less what has come back.
          outstandingMinor: {
            $sum: { $subtract: ["$amountMinor", { $sum: "$repayments.amountMinor" }] },
          },
          count: { $sum: 1 },
        },
      },
    ]),
    LedgerEntry.aggregate([
      {
        $match: {
          ledgerId,
          isDeleted: false,
          type: LEDGER_ENTRY_TYPES.SPEND,
          ...(spendSince ? { occurredAt: { $gte: spendSince } } : {}),
        },
      },
      /**
       * Grouped by origin so the two tabs can each show their own figure.
       *
       * The split is presentational — "what I spent alone" and "my share of what
       * we spent together" are different questions people ask separately — but
       * `spentMinor` stays the sum of both, because "what did I spend this month"
       * has one answer and it is not half of one.
       */
      {
        $group: {
          _id: { $ifNull: ["$source", "MANUAL"] },
          totalMinor: { $sum: "$amountMinor" },
          count: { $sum: 1 },
        },
      },
    ]),
    repaidBorrowedTotal(ledgerId, spendSince),
  ]);

  const byType = new Map(debts.map((row) => [row._id, row]));
  const bySource = new Map(spend.map((row) => [row._id, row]));
  const manual = bySource.get("MANUAL") || { totalMinor: 0, count: 0 };
  const fromGroups = bySource.get("GROUP_EXPENSE") || { totalMinor: 0, count: 0 };

  return {
    owedToMeMinor: byType.get(LEDGER_ENTRY_TYPES.LENT)?.outstandingMinor || 0,
    owedToMeCount: byType.get(LEDGER_ENTRY_TYPES.LENT)?.count || 0,
    iOweMinor: byType.get(LEDGER_ENTRY_TYPES.BORROWED)?.outstandingMinor || 0,
    iOweCount: byType.get(LEDGER_ENTRY_TYPES.BORROWED)?.count || 0,
    /**
     * Every rupee that actually left the owner's pocket this window: spends,
     * plus whatever they paid back on money they had borrowed. Money coming
     * *back* to the owner — a repayment on something they lent — is not spend
     * and is intentionally excluded; see `repaidBorrowedTotal` above.
     */
    spentMinor: manual.totalMinor + fromGroups.totalMinor + repaid.totalMinor,
    spentCount: manual.count + fromGroups.count + repaid.count,
    /** Spent alone. */
    spentOwnMinor: manual.totalMinor,
    spentOwnCount: manual.count,
    /** My share of what the groups spent. */
    spentGroupMinor: fromGroups.totalMinor,
    spentGroupCount: fromGroups.count,
    /** The new component of `spentMinor`: paid back this window on a debt owed. */
    repaidBorrowedMinor: repaid.totalMinor,
    repaidBorrowedCount: repaid.count,
  };
};

/** Spending grouped by category, for the month view. */
const spendByCategory = (ledgerId, since) =>
  LedgerEntry.aggregate([
    {
      $match: {
        ledgerId,
        isDeleted: false,
        type: LEDGER_ENTRY_TYPES.SPEND,
        ...(since ? { occurredAt: { $gte: since } } : {}),
      },
    },
    { $group: { _id: "$category", totalMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
    { $sort: { totalMinor: -1 } },
  ]);

/**
 * Raw rows for the "by month" view, covering the last `months` calendar
 * months including the current, partial one.
 *
 * Deliberately **not** grouped by month in the aggregation, unlike everything
 * else in this file. Mongo's `$year`/`$month` operators bucket in UTC, while
 * every other month boundary here — `startOfMonth` in ledgerService, this same
 * function's own `since` — is the server's local clock. Grouping in Mongo
 * would give this view a second, disagreeing definition of "which month
 * something falls in", silently off by a day right at the boundary. Row counts
 * here are one person's ledger, bounded by `months` (capped at 24), so
 * fetching the raw rows and bucketing them in JS in the service — the same way
 * `monthKey` already does — costs nothing and keeps one definition instead of
 * two.
 */
const spendByMonth = async (ledgerId, months = 6) => {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(1);
  since.setMonth(since.getMonth() - (months - 1));

  const [spendRows, borrowedEntries] = await Promise.all([
    LedgerEntry.find({
      ledgerId,
      isDeleted: false,
      type: LEDGER_ENTRY_TYPES.SPEND,
      occurredAt: { $gte: since },
    })
      .select("occurredAt amountMinor source")
      .lean(),
    LedgerEntry.find({
      ledgerId,
      isDeleted: false,
      type: LEDGER_ENTRY_TYPES.BORROWED,
      "repayments.paidAt": { $gte: since },
    })
      .select("repayments")
      .lean(),
  ]);

  /**
   * Just the repayments inside the window. An entry matches the query above
   * the moment *one* of its repayments is recent enough — older instalments on
   * the same loan must not be pulled in with it.
   */
  const repayments = borrowedEntries.flatMap((entry) =>
    (entry.repayments || []).filter((repayment) => repayment.paidAt >= since)
  );

  return { since, spendRows, repayments };
};

module.exports = {
  findByUser,
  createForUser,
  touchActivity,
  listEntries,
  findEntry,
  createEntry,
  softDeleteEntry,
  totals,
  spendByCategory,
  spendByMonth,
};
