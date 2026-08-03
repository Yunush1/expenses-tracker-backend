const Member = require("../models/member");

const create = (payload, session = null) =>
  Member.create(session ? [payload] : payload, session ? { session } : undefined).then((res) =>
    Array.isArray(res) ? res[0] : res
  );

const findByGroup = (groupId, { includeInactive = false } = {}) => {
  const filter = { groupId };
  if (!includeInactive) filter.isActive = true;
  return Member.find(filter).sort({ joinedAt: 1 }).lean();
};

const findByDevice = (groupId, deviceId) => {
  if (!deviceId) return Promise.resolve(null);
  return Member.findOne({ groupId, deviceId, isActive: true }).lean();
};

const findById = (groupId, memberId) => Member.findOne({ _id: memberId, groupId });

const findActiveByIds = (groupId, memberIds) =>
  Member.find({ groupId, _id: { $in: memberIds }, isActive: true }).lean();

const updateById = (groupId, memberId, update) =>
  Member.findOneAndUpdate({ _id: memberId, groupId }, update, { new: true, runValidators: true });

const deactivate = (groupId, memberId) =>
  Member.findOneAndUpdate({ _id: memberId, groupId }, { $set: { isActive: false } }, { new: true });

const countActive = (groupId) => Member.countDocuments({ groupId, isActive: true });

const deleteByGroup = (groupId, session = null) => Member.deleteMany({ groupId }, { session });

module.exports = {
  create,
  findByGroup,
  findByDevice,
  findById,
  findActiveByIds,
  updateById,
  deactivate,
  countActive,
  deleteByGroup,
};
