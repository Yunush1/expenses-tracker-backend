const DueRequest = require("../models/dueRequest");
const { DUE_REQUEST_STATUS } = require("../constants");

const create = (payload) => DueRequest.create(payload);

const findById = (groupId, requestId) => DueRequest.findOne({ _id: requestId, groupId }).lean();

const findPending = (groupId, { kind, fromMemberId, toMemberId }) =>
  DueRequest.findOne({ groupId, kind, fromMemberId, toMemberId, status: DUE_REQUEST_STATUS.PENDING }).lean();

/** Every open request in the group. Small by construction — one per kind per pair. */
const listPending = (groupId) =>
  DueRequest.find({ groupId, status: DUE_REQUEST_STATUS.PENDING }).sort({ createdAt: -1 }).lean();

/** Recent requests involving one member, decided ones included, newest first. */
const listInvolving = (groupId, memberId, limit = 50) =>
  DueRequest.find({ groupId, $or: [{ fromMemberId: memberId }, { toMemberId: memberId }] })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

/**
 * Move a request out of PENDING — atomically, and only if it is still PENDING.
 *
 * Returns the updated row, or null when somebody else decided it first. That null
 * is what stops a double-tapped Accept from writing the carry-forward twice: only
 * the call that wins this update goes on to write anything.
 */
const decide = (groupId, requestId, status, extra = {}, session = null) =>
  DueRequest.findOneAndUpdate(
    { _id: requestId, groupId, status: DUE_REQUEST_STATUS.PENDING },
    { $set: { status, respondedAt: new Date(), ...extra } },
    { new: true, ...(session ? { session } : {}) }
  ).lean();

/** Bulk-close requests the service has found to be stale (resolved or expired). */
const closeMany = (groupId, ids, status) =>
  ids.length === 0
    ? Promise.resolve(null)
    : DueRequest.updateMany(
        { _id: { $in: ids }, groupId, status: DUE_REQUEST_STATUS.PENDING },
        { $set: { status, respondedAt: new Date() } }
      );

/** Undo a claim whose follow-up write failed, on deployments with no transactions. */
const reopen = (groupId, requestId) =>
  DueRequest.updateOne(
    { _id: requestId, groupId },
    { $set: { status: DUE_REQUEST_STATUS.PENDING, respondedAt: null } }
  );

const setPairId = (groupId, requestId, pairId) =>
  DueRequest.updateOne({ _id: requestId, groupId }, { $set: { pairId } });

const deleteByGroup = (groupId, session = null) => DueRequest.deleteMany({ groupId }, { session });

module.exports = {
  reopen,
  setPairId,
  create,
  findById,
  findPending,
  listPending,
  listInvolving,
  decide,
  closeMany,
  deleteByGroup,
};
