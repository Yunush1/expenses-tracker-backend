const mongoose = require("mongoose");
const Expense = require("../models/expense");
const { decodeCursor } = require("../utils/cursor");

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
const listByGroup = async (groupId, { cursor, limit, memberId, paidBy } = {}) => {
  const filter = { groupId, isDeleted: false };

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
    filter.$or = [{ paidBy: memberId }, { "shares.memberId": memberId }];
  }

  const anchor = decodeCursor(cursor);
  if (anchor) filter._id = { $lt: anchor };

  return Expense.find(filter)
    .sort({ _id: -1 })
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
  deleteByGroup,
};
