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

/**
 * The `$or` covers members written before the deviceIds[] migration, so the app
 * keeps resolving identities whether or not `npm run migrate:devices` has run yet.
 */
const findByDevice = (groupId, deviceId) => {
  if (!deviceId) return Promise.resolve(null);
  return Member.findOne({
    groupId,
    isActive: true,
    $or: [{ deviceIds: deviceId }, { deviceId }],
  }).lean();
};

const addDevice = (groupId, memberId, deviceId) =>
  Member.findOneAndUpdate(
    { _id: memberId, groupId },
    { $addToSet: { deviceIds: deviceId }, $set: { "linkCode.hash": null, "linkCode.expiresAt": null } },
    { new: true }
  );

const removeDevice = async (groupId, memberId, deviceId) => {
  await Member.updateOne({ _id: memberId, groupId }, { $pull: { deviceIds: deviceId } });

  /**
   * The legacy scalar is cleared only when it holds *this* device. An
   * unconditional $unset would cut loose a different, still-valid device on any
   * member that has not been migrated yet — they can hold one id in each field.
   */
  await Member.updateOne({ _id: memberId, groupId, deviceId }, { $unset: { deviceId: "" } });

  return Member.findOne({ _id: memberId, groupId });
};

const findByLinkCodeHash = (groupId, hash) =>
  Member.findOne({ groupId, isActive: true, "linkCode.hash": hash }).lean();

const setLinkCode = (groupId, memberId, hash, expiresAt) =>
  Member.findOneAndUpdate(
    { _id: memberId, groupId },
    { $set: { linkCode: { hash, expiresAt } } },
    { new: true }
  );

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
  addDevice,
  removeDevice,
  findByLinkCodeHash,
  setLinkCode,
  findById,
  findActiveByIds,
  updateById,
  deactivate,
  countActive,
  deleteByGroup,
};
