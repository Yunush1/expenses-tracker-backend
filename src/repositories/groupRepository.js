const Group = require("../models/group");
const { GROUP_STATUS } = require("../constants");

/** All group queries live here. No business rules — those belong to the service. */

const create = (payload, session = null) =>
  Group.create(session ? [payload] : payload, session ? { session } : undefined).then((res) =>
    Array.isArray(res) ? res[0] : res
  );

const findByInviteCode = (inviteCode) => Group.findOne({ inviteCode });

const findById = (id) => Group.findById(id);

/** Names for a set of groups, in one round trip. Read-only — hence `.lean()`. */
const findByIds = (ids) =>
  Group.find({ _id: { $in: ids } })
    .select("_id name currency")
    .lean();

const existsByInviteCode = (inviteCode) => Group.exists({ inviteCode });

/** Deleted groups are excluded — a retired code should read as simply unknown. */
const findByJoinCode = (joinCode) =>
  Group.findOne({ joinCode, status: { $ne: GROUP_STATUS.DELETED } });

/**
 * Is this short code spoken for?
 *
 * ## This must mirror the unique index, and once did not
 *
 * `models/group.js` indexes `{ joinCode: 1 }` as unique over **every** group
 * holding a string code, whatever its status. This predicate used to narrow that
 * to `status: ACTIVE`, and the disagreement was a real bug: a code belonging to an
 * archived or deleted group read as free here, `resolveJoinCode` let it through,
 * and the insert then failed on the index with a raw `E11000` that the error
 * middleware turned into "That record already exists" — a 409 naming no field,
 * for a code the app had just implied was available.
 *
 * So the filter is now status-blind, exactly like the index. Deleted groups no
 * longer appear because `deleteGroup` releases the code outright (see there for
 * why); archived groups do appear, and should — an archived group still exists,
 * is still readable, and its code is still its own.
 *
 * Two things have to agree about what "taken" means, and the index is the one
 * that gets the last word. This is the other one.
 */
const existsByJoinCode = (joinCode) => {
  // A null code is "no code", not a code every group shares. Without this guard a
  // stray null would match the first group with no join code and report every
  // requested code as taken, which fails group creation for everyone.
  if (!joinCode) return Promise.resolve(null);
  return Group.exists({ joinCode });
};

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
  findByIds,
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
