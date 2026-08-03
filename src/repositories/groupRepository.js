const Group = require("../models/group");
const { GROUP_STATUS } = require("../constants");

/** All group queries live here. No business rules — those belong to the service. */

const create = (payload, session = null) =>
  Group.create(session ? [payload] : payload, session ? { session } : undefined).then((res) =>
    Array.isArray(res) ? res[0] : res
  );

const findByInviteCode = (inviteCode) => Group.findOne({ inviteCode });

const findById = (id) => Group.findById(id);

const existsByInviteCode = (inviteCode) => Group.exists({ inviteCode });

/** Deleted groups are excluded — a retired code should read as simply unknown. */
const findByJoinCode = (joinCode) =>
  Group.findOne({ joinCode, status: { $ne: GROUP_STATUS.DELETED } });

const existsByJoinCode = (joinCode) => Group.exists({ joinCode });

const updateById = (id, update) => Group.findByIdAndUpdate(id, update, { new: true, runValidators: true });

const incrementMemberCount = (id, delta, session = null) =>
  Group.findByIdAndUpdate(
    id,
    { $inc: { memberCount: delta }, $set: { lastActivityAt: new Date() } },
    { new: true, session }
  );

const touchActivity = (id) =>
  Group.updateOne({ _id: id }, { $set: { lastActivityAt: new Date() } }).catch(() => null);

const setStatus = (id, status) =>
  Group.findByIdAndUpdate(id, { $set: { status } }, { new: true });

const deleteHard = (id, session = null) => Group.deleteOne({ _id: id }, { session });

module.exports = {
  create,
  findByInviteCode,
  findById,
  existsByInviteCode,
  findByJoinCode,
  existsByJoinCode,
  updateById,
  incrementMemberCount,
  touchActivity,
  setStatus,
  deleteHard,
  GROUP_STATUS,
};
