const mongoose = require("mongoose");
const Expense = require("../models/expense");
const { decodeKeyCursor, keyCursorFilter } = require("../utils/cursor");

const create = (payload, session = null) =>
  Expense.create(session ? [payload] : payload, session ? { session } : undefined).then((res) =>
    Array.isArray(res) ? res[0] : res
  );

const findById = (groupId, expenseId) =>
  Expense.findOne({ _id: expenseId, groupId, isDeleted: false });

const findByClientRequestId = (groupId, clientRequestId) => {
  if (!clientRequestId) return Promise.resolve(null);
  return Expense.findOne({ groupId, clientRequestId }).lean();
};

/**
 * Over-fetches by one row so the caller can detect a further page without a
 * second count query. Cursor is an ObjectId anchor, not an offset.
 */
/** Anything a user types is a literal, not a pattern. */
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `date` means whichever date field the caller chose — see `dateField` below. */
const SORT_FIELDS = {
  date: (dateField) => dateField,
  amount: () => "amountMinor",
};

const listByGroup = async (
  groupId,
  {
    cursor,
    limit,
    memberId,
    paidBy,
    q,
    category,
    from,
    to,
    /**
     * Which date the filters and the sort mean.
     *
     * `expenseDate` is when the money moved; `createdAt` is when somebody typed it
     * in. They are routinely days apart — a trip settled up the following weekend
     * — and the two questions ("what did we spend in Goa?" versus "what got added
     * since I last looked?") have different answers. Defaulting to `expenseDate`
     * keeps the existing behaviour.
     */
    dateField = "expenseDate",
    sort = "date_desc",
  } = {}
) => {
  const filter = { groupId, isDeleted: false };
  const and = [];

  /**
   * Two different questions, deliberately two filters.
   *
   * `memberId` asks "which expenses concern me" — paid by me *or* splitting onto
   * me — and in a group where everyone shares everything that is very nearly all
   * of them. `paidBy` asks "which are mine", the question someone is answering
   * when they scan for whether they already entered the taxi fare. Collapsing
   * them into one parameter would make the per-person view show every member's
   * section containing nearly every expense.
   */
  if (paidBy) {
    filter.paidBy = paidBy;
  } else if (memberId) {
    // Inside `$and` rather than on the filter, so it cannot collide with the
    // cursor's own `$or` — two `$or` keys on one object silently keep the last.
    and.push({ $or: [{ paidBy: memberId }, { "shares.memberId": memberId }] });
  }

  /**
   * Search across the description and the notes.
   *
   * A case-insensitive substring rather than a text index: the search is always
   * scoped to one group, which is hundreds of rows at most, and `$text` would
   * match whole words only — so "grocer" would not find "groceries", which is
   * exactly how people search.
   */
  if (q && String(q).trim()) {
    const pattern = new RegExp(escapeRegex(String(q).trim()), "i");
    and.push({ $or: [{ description: pattern }, { notes: pattern }] });
  }

  if (category) {
    // "Uncategorised" is a real answer, and the field is null on rows written
    // before inference existed as well as on genuinely unmatched ones.
    filter.category = category === "UNCATEGORISED" ? { $in: [null, ""] } : category;
  }

  /**
   * Whole days, not instants.
   *
   * A date picker sends a date; what arrives is a timestamp with whatever
   * time-of-day the browser attached. Compared literally, "from 5 August" means
   * "from 5 August at 14:32", and the lunch someone logged that morning silently
   * falls outside a range they picked to include it. Nobody reads a date filter
   * as having a time component, so neither does this.
   *
   * Day boundaries are UTC, which is the same simplification the rest of the app
   * makes (points use a UTC day key). For a user more than a few hours off UTC an
   * expense near midnight can land on the neighbouring day — visible only at the
   * very edge of a range, and the alternative is threading a timezone through
   * every list request.
   */
  const range = {};
  if (from) {
    const start = new Date(from);
    start.setUTCHours(0, 0, 0, 0);
    range.$gte = start;
  }
  if (to) {
    const end = new Date(to);
    end.setUTCHours(23, 59, 59, 999);
    range.$lte = end;
  }
  if (Object.keys(range).length > 0) filter[dateField] = range;

  const [sortKey, sortDir] = String(sort).split("_");
  const field = (SORT_FIELDS[sortKey] || SORT_FIELDS.date)(dateField);
  const direction = sortDir === "asc" ? 1 : -1;

  const anchor = decodeKeyCursor(cursor);
  const cursorFilter = keyCursorFilter(anchor, field, direction);
  if (cursorFilter) and.push(cursorFilter);

  if (and.length > 0) filter.$and = and;

  return Expense.find(filter)
    // `_id` breaks ties, which is what makes paging total when several expenses
    // share a date or an amount.
    .sort({ [field]: direction, _id: direction })
    .limit(limit + 1)
    .lean();
};

const updateById = (groupId, expenseId, update, expectedVersion) =>
  Expense.findOneAndUpdate(
    { _id: expenseId, groupId, isDeleted: false, version: expectedVersion },
    update,
    { new: true, runValidators: true }
  );

const softDelete = (groupId, expenseId, deletedByMemberId) =>
  Expense.findOneAndUpdate(
    { _id: expenseId, groupId, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedByMemberId } },
    { new: true }
  );

/**
 * Every expense referencing a member, deleted ones included — a merge has to rewrite
 * soft-deleted rows too or the audit trail would still point at an identity that no
 * longer exists.
 */
const listAllInvolvingMember = (groupId, memberId) =>
  Expense.find({
    groupId,
    $or: [
      { paidBy: memberId },
      { createdByMemberId: memberId },
      { deletedByMemberId: memberId },
      { "shares.memberId": memberId },
      { "splitValues.memberId": memberId },
    ],
  }).lean();

/**
 * Used only by the merge, which rewrites member references without touching money.
 * Bumps `version` so a client holding the pre-merge copy is told to reload rather
 * than overwriting the reassigned shares.
 */
const applyMergePatch = (groupId, expenseId, patch, session = null) =>
  Expense.updateOne(
    { _id: expenseId, groupId },
    { $set: patch, $inc: { version: 1 } },
    session ? { session } : undefined
  );

const countByGroup = (groupId) => Expense.countDocuments({ groupId, isDeleted: false });

/** Counts non-deleted expenses a member is involved in, as payer or participant. */
const countInvolvingMember = (groupId, memberId) =>
  Expense.countDocuments({
    groupId,
    isDeleted: false,
    $or: [{ paidBy: memberId }, { "shares.memberId": memberId }],
  });

/**
 * Single pass over a group's live expenses producing everything the balance
 * calculation needs: per-member paid totals, per-member share totals, and the
 * group aggregate. See docs/03-LLD.md §5.4.
 */
const aggregateTotals = (groupId) =>
  Expense.aggregate([
    { $match: { groupId: new mongoose.Types.ObjectId(String(groupId)), isDeleted: false } },
    {
      $facet: {
        // `count` rides along free — the group stage is already scanning these
        // rows, and the per-person expense view needs "4 expenses · ₹2,400"
        // without loading four expenses to find out.
        paid: [{ $group: { _id: "$paidBy", total: { $sum: "$amountMinor" }, count: { $sum: 1 } } }],
        shared: [
          { $unwind: "$shares" },
          { $group: { _id: "$shares.memberId", total: { $sum: "$shares.amountMinor" } } },
        ],
        overall: [
          { $group: { _id: null, totalSpentMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
        ],
      },
    },
  ]);

/**
 * Which months and years this group actually has expenses in.
 *
 * ## Why the server decides which periods exist
 *
 * A flatshare runs for years in one group, and the alternative — a month picker
 * offering every month since the group was made — sends people tapping through
 * empty screens to find the three months that have anything in them. Offering
 * only the real ones turns navigation into a short list.
 *
 * The totals ride along free: the group stage is already scanning these rows, and
 * the period header needs "₹12,400 across 23 expenses" without fetching 23
 * expenses to add them up.
 *
 * Grouped in UTC, like every other day boundary in this app. An expense logged
 * near midnight on the 1st can land in the neighbouring month for someone far
 * from UTC — at the edge of a month, on a figure nobody settles on.
 */
const periods = (groupId) =>
  Expense.aggregate([
    { $match: { groupId: new mongoose.Types.ObjectId(String(groupId)), isDeleted: false } },
    {
      $group: {
        _id: {
          year: { $year: { date: "$expenseDate", timezone: "UTC" } },
          month: { $month: { date: "$expenseDate", timezone: "UTC" } },
        },
        totalMinor: { $sum: "$amountMinor" },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": -1, "_id.month": -1 } },
  ]);

/**
 * Where the money went, grouped by category.
 *
 * ## Two different sums, and why they cannot be one
 *
 * For the **group**, the figure is `amountMinor` — what the expense cost. For **one
 * member**, it is that member's share, because ₹3,000 of rent split four ways is
 * ₹750 of their money and nobody wants to see their own spending inflated by three
 * flatmates. Summing the full amount per member would make every member's total add
 * up to four times the group's, which is the kind of number people notice and stop
 * trusting the screen over.
 *
 * ## Uncategorised is a bucket, not an omission
 *
 * `category` is null on everything written before inference existed, and empty on
 * anything the rules did not match. Both are folded into one `UNCATEGORISED` key
 * rather than dropped: a breakdown whose slices do not add up to the total people
 * can see on the same screen is a breakdown they will assume is broken.
 */
const categoryTotals = (groupId, { from, to, memberId } = {}) => {
  const match = { groupId: new mongoose.Types.ObjectId(String(groupId)), isDeleted: false };

  // Whole days, matching listByGroup — see the note there for why.
  const range = {};
  if (from) {
    const start = new Date(from);
    start.setUTCHours(0, 0, 0, 0);
    range.$gte = start;
  }
  if (to) {
    const end = new Date(to);
    end.setUTCHours(23, 59, 59, 999);
    range.$lte = end;
  }
  if (Object.keys(range).length > 0) match.expenseDate = range;

  /** Null, empty and missing all mean the same thing to a reader. */
  const categoryKey = {
    $ifNull: [{ $cond: [{ $eq: ["$category", ""] }, null, "$category"] }, "UNCATEGORISED"],
  };

  const stages = [{ $match: match }];

  if (memberId) {
    stages.push(
      { $unwind: "$shares" },
      { $match: { "shares.memberId": new mongoose.Types.ObjectId(String(memberId)) } },
      {
        $group: {
          _id: categoryKey,
          totalMinor: { $sum: "$shares.amountMinor" },
          count: { $sum: 1 },
        },
      }
    );
  } else {
    stages.push({
      $group: { _id: categoryKey, totalMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } },
    });
  }

  // Largest first: the question is "where did it go", and the answer is the top row.
  stages.push({ $sort: { totalMinor: -1 } });

  return Expense.aggregate(stages);
};

/**
 * Every live expense in a range, oldest first — the export's query.
 *
 * Deliberately **not** paginated, unlike `listByGroup`. An export is one file and
 * a partial one is worse than none: a spreadsheet whose totals silently stop at
 * page one is a wrong answer that looks like a right one. The bound is the group
 * itself — a flatshare running for years is thousands of rows, not millions — and
 * the index on `{ groupId, isDeleted, expenseDate }` serves it directly.
 *
 * Oldest first because that is how a ledger reads and how a spreadsheet's running
 * total is built, which is the opposite of the screen's newest-first.
 */
const listAllByGroup = (groupId, { from, to } = {}) => {
  const filter = { groupId, isDeleted: false };

  // Whole days, matching listByGroup — see the note there.
  const range = {};
  if (from) {
    const start = new Date(from);
    start.setUTCHours(0, 0, 0, 0);
    range.$gte = start;
  }
  if (to) {
    const end = new Date(to);
    end.setUTCHours(23, 59, 59, 999);
    range.$lte = end;
  }
  if (Object.keys(range).length > 0) filter.expenseDate = range;

  return Expense.find(filter).sort({ expenseDate: 1, _id: 1 }).lean();
};

/**
 * Which of these groups are **activated** — two or more members have paid for
 * something.
 *
 * ## Why two payers, and not two members or one expense
 *
 * This is docs/22-MONETIZATION.md §12's definition, and it is the one that
 * resists being farmed. A group with five members and one payer is one person
 * with a spreadsheet; a group with one expense is a group somebody opened. Two
 * distinct people having each put money in is the smallest fact that cannot be
 * produced by a single person in an afternoon, which is exactly what a referral
 * payout has to be attached to (§11).
 *
 * Deleted expenses do not count, or the farm is "add two, delete two".
 *
 * Takes a list and returns a list, because the caller is checking every group one
 * person belongs to and a query per group would be a loop over the database on a
 * path triggered by somebody else's first expense.
 */
const activatedGroupIds = async (groupIds = []) => {
  const ids = groupIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  if (ids.length === 0) return [];

  const rows = await Expense.aggregate([
    { $match: { groupId: { $in: ids }, isDeleted: false } },
    // One row per (group, payer) — distinct payers, without loading any expense.
    { $group: { _id: { groupId: "$groupId", paidBy: "$paidBy" } } },
    { $group: { _id: "$_id.groupId", payers: { $sum: 1 } } },
    { $match: { payers: { $gte: 2 } } },
  ]);

  return rows.map((row) => String(row._id));
};

const deleteByGroup = (groupId, session = null) => Expense.deleteMany({ groupId }, { session });

module.exports = {
  create,
  findById,
  findByClientRequestId,
  listByGroup,
  updateById,
  softDelete,
  listAllInvolvingMember,
  applyMergePatch,
  countByGroup,
  countInvolvingMember,
  aggregateTotals,
  periods,
  categoryTotals,
  listAllByGroup,
  activatedGroupIds,
  deleteByGroup,
};
