const mongoose = require("mongoose");
const Expense = require("../models/expense");
const { decodeCursor } = require("../utils/cursor");

const create = (payload) => Expense.create(payload);

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
const listByGroup = async (groupId, { cursor, limit, memberId } = {}) => {
  const filter = { groupId, isDeleted: false };

  if (memberId) {
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
        paid: [{ $group: { _id: "$paidBy", total: { $sum: "$amountMinor" } } }],
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
  countByGroup,
  countInvolvingMember,
  aggregateTotals,
  deleteByGroup,
};
