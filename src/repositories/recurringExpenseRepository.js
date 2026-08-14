const RecurringExpense = require("../models/recurringExpense");

/** All recurring-template queries. The schedule arithmetic lives in utils/recurrence. */

const create = (payload) => RecurringExpense.create(payload);

const findById = (groupId, id) =>
  RecurringExpense.findOne({ _id: id, groupId, isDeleted: false });

/**
 * A group's live templates, oldest first.
 *
 * The order is load-bearing rather than cosmetic: when a group holds more
 * templates than its plan covers, the ones that keep running are the first N in
 * this list. Creation order is the only ordering that is stable, explicable
 * ("the ones you set up first"), and immune to being gamed by renaming.
 */
const findByGroup = (groupId) =>
  RecurringExpense.find({ groupId, isDeleted: false }).sort({ createdAt: 1 });

const countByGroup = (groupId) =>
  RecurringExpense.countDocuments({ groupId, isDeleted: false });

const updateById = (groupId, id, update) =>
  RecurringExpense.findOneAndUpdate(
    { _id: id, groupId, isDeleted: false },
    update,
    { new: true, runValidators: true }
  );

/**
 * Soft delete, like expenses.
 *
 * The expenses this template already produced are untouched and always will be —
 * they are the group's financial record, and somebody removing "rent" because they
 * moved out is saying "stop making these", not "the last eight months did not
 * happen".
 */
const softDelete = (groupId, id) =>
  RecurringExpense.findOneAndUpdate(
    { _id: id, groupId, isDeleted: false },
    { $set: { isDeleted: true } },
    { new: true }
  );

/**
 * Everything due, across every group — the job's only query.
 *
 * Served entirely by the `{ isDeleted, isPaused, nextRunAt }` index, and bounded:
 * a tick that finds ten thousand due templates should do a thousand of them and
 * pick the rest up fifteen minutes later, rather than hold one process for
 * however long ten thousand takes.
 */
const findDue = (now = new Date(), limit = 500) =>
  RecurringExpense.find({ isDeleted: false, isPaused: false, nextRunAt: { $lte: now } })
    .sort({ nextRunAt: 1 })
    .limit(limit);

/** After a successful materialisation: advance the schedule and count the run. */
const recordRun = (id, { nextRunAt, ranAt, produced }) =>
  RecurringExpense.updateOne(
    { _id: id },
    { $set: { nextRunAt, lastRunAt: ranAt }, $inc: { runCount: produced } }
  );

/**
 * After a due date the plan did not cover: advance without producing anything.
 *
 * The advance is the important half. Leaving `nextRunAt` in the past would build a
 * backlog that materialises all at once the moment the group is entitled again —
 * six months of rent landing in one tick and moving everybody's balance.
 */
const recordSkip = (id, { nextRunAt, skippedAt, skipped }) =>
  RecurringExpense.updateOne(
    { _id: id },
    { $set: { nextRunAt, lastSkippedAt: skippedAt }, $inc: { skippedCount: skipped } }
  );

/** Everything referencing a member — used by the merge, like expenses. */
const listAllInvolvingMember = (groupId, memberId) =>
  RecurringExpense.find({
    groupId,
    $or: [
      { paidBy: memberId },
      { createdByMemberId: memberId },
      { participantIds: memberId },
      { "splitValues.memberId": memberId },
    ],
  });

const deleteByGroup = (groupId, session = null) =>
  RecurringExpense.deleteMany({ groupId }, { session });

module.exports = {
  create,
  findById,
  findByGroup,
  countByGroup,
  updateById,
  softDelete,
  findDue,
  recordRun,
  recordSkip,
  listAllInvolvingMember,
  deleteByGroup,
};
