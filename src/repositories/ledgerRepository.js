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
const listEntries = (ledgerId, { cursor, limit, type, settled } = {}) => {
  const filter = { ledgerId, isDeleted: false };

  if (type) filter.type = type;

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
 * The three headline figures, computed in the database rather than by loading
 * every entry — the ledger summary is the most-hit read and must not scale with
 * how long someone has been using it.
 *
 * `spentMinor` is bounded to a window; the debts are not, because an unsettled
 * loan from two years ago is still owed.
 */
const totals = async (ledgerId, { spendSince } = {}) => {
  const [debts, spend] = await Promise.all([
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
      { $group: { _id: null, totalMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
    ]),
  ]);

  const byType = new Map(debts.map((row) => [row._id, row]));

  return {
    owedToMeMinor: byType.get(LEDGER_ENTRY_TYPES.LENT)?.outstandingMinor || 0,
    owedToMeCount: byType.get(LEDGER_ENTRY_TYPES.LENT)?.count || 0,
    iOweMinor: byType.get(LEDGER_ENTRY_TYPES.BORROWED)?.outstandingMinor || 0,
    iOweCount: byType.get(LEDGER_ENTRY_TYPES.BORROWED)?.count || 0,
    spentMinor: spend[0]?.totalMinor || 0,
    spentCount: spend[0]?.count || 0,
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
};
