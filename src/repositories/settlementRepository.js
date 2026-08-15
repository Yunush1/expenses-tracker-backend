const mongoose = require("mongoose");
const Settlement = require("../models/settlement");
const { decodeCursor } = require("../utils/cursor");

const create = (payload) => Settlement.create(payload);

const findByClientRequestId = (groupId, clientRequestId) => {
  if (!clientRequestId) return Promise.resolve(null);
  return Settlement.findOne({ groupId, clientRequestId }).lean();
};

const listByGroup = (groupId, { cursor, limit } = {}) => {
  const filter = { groupId };

  const anchor = decodeCursor(cursor);
  if (anchor) filter._id = { $lt: anchor };

  return Settlement.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
};

const countByGroup = (groupId) => Settlement.countDocuments({ groupId });

const countInvolvingMember = (groupId, memberId) =>
  Settlement.countDocuments({
    groupId,
    $or: [{ fromMemberId: memberId }, { toMemberId: memberId }],
  });

const listAllInvolvingMember = (groupId, memberId) =>
  Settlement.find({
    groupId,
    $or: [
      { fromMemberId: memberId },
      { toMemberId: memberId },
      { recordedByMemberId: memberId },
    ],
  }).lean();

const applyMergePatch = (groupId, settlementId, patch, session = null) =>
  Settlement.updateOne({ _id: settlementId, groupId }, { $set: patch }, session ? { session } : undefined);

/**
 * The only place a settlement is ever removed. A merge can turn a payment between
 * two members into one from a person to themselves, which is not a payment — and
 * because it added and subtracted the same amount for the same person, removing it
 * leaves every balance unchanged. What was removed is recorded in the activity log.
 */
const deleteById = (groupId, settlementId, session = null) =>
  Settlement.deleteOne({ _id: settlementId, groupId }, session ? { session } : undefined);

/** Per-member paid/received settlement totals for the balance formula. */
const aggregateTotals = (groupId) =>
  Settlement.aggregate([
    { $match: { groupId: new mongoose.Types.ObjectId(String(groupId)) } },
    {
      $facet: {
        paid: [{ $group: { _id: "$fromMemberId", total: { $sum: "$amountMinor" } } }],
        received: [{ $group: { _id: "$toMemberId", total: { $sum: "$amountMinor" } } }],
        overall: [{ $group: { _id: null, count: { $sum: 1 } } }],
      },
    },
  ]);

/**
 * Every settlement in a range, oldest first — the export's query.
 *
 * Unpaginated for the same reason as the expense one: an export is a file, and a
 * partial file is a wrong total that looks like a right one.
 */
const listAllByGroup = (groupId, { from, to } = {}) => {
  const filter = { groupId };

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
  if (Object.keys(range).length > 0) filter.settledAt = range;

  return Settlement.find(filter).sort({ settledAt: 1, _id: 1 }).lean();
};

const deleteByGroup = (groupId, session = null) => Settlement.deleteMany({ groupId }, { session });

module.exports = {
  create,
  findByClientRequestId,
  listByGroup,
  listAllByGroup,
  countByGroup,
  countInvolvingMember,
  listAllInvolvingMember,
  applyMergePatch,
  deleteById,
  aggregateTotals,
  deleteByGroup,
};
