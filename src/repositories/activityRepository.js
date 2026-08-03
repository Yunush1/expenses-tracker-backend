const Activity = require("../models/activity");
const { decodeCursor } = require("../utils/cursor");

/** Append-only: there is deliberately no update or single-delete method here. */

const create = (payload, session = null) =>
  Activity.create(session ? [payload] : payload, session ? { session } : undefined).then((res) =>
    Array.isArray(res) ? res[0] : res
  );

const listByGroup = (groupId, { cursor, limit, type } = {}) => {
  const filter = { groupId };
  if (type) filter.type = type;

  const anchor = decodeCursor(cursor);
  if (anchor) filter._id = { $lt: anchor };

  return Activity.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
};

const deleteByGroup = (groupId, session = null) => Activity.deleteMany({ groupId }, { session });

module.exports = { create, listByGroup, deleteByGroup };
