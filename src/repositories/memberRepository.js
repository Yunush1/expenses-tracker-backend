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

/**
 * The member this account already holds in this group, if any.
 *
 * Used to refuse a second link rather than to resolve identity — one account
 * holding two members in one group is a merge case, not a lookup
 * (docs/17-MEMBER-IDENTITY.md §13).
 */
const findByUserId = (groupId, userId) =>
  Member.findOne({ groupId, userId, isActive: true }).lean();

/** Every member row this account holds, across all groups. */
const findAllByUserId = (userId) => Member.find({ userId, isActive: true }).lean();

/** Everyone in these groups — the candidate counterparties for a ledger entry. */
const findActiveInGroups = (groupIds) =>
  Member.find({ groupId: { $in: groupIds }, isActive: true })
    .select("_id groupId name userId")
    .lean();

/**
 * Bind, but only over an empty link.
 *
 * `userId: null` in the filter is the guard, not a formality: it makes the write
 * conditional inside the database, so two requests racing to claim the same
 * member cannot both read "unlinked" and both succeed. The loser gets null back
 * and the service turns that into MEMBER_ALREADY_LINKED.
 */
const linkUser = (groupId, memberId, userId) =>
  Member.findOneAndUpdate(
    { _id: memberId, groupId, userId: null },
    { $set: { userId } },
    { new: true }
  );

const unlinkUser = (groupId, memberId, userId) =>
  Member.findOneAndUpdate({ _id: memberId, groupId, userId }, { $set: { userId: null } }, { new: true });

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
  findByUserId,
  findAllByUserId,
  findActiveInGroups,
  linkUser,
  unlinkUser,
  findActiveByIds,
  updateById,
  deactivate,
  countActive,
  deleteByGroup,
};
