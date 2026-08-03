const mongoose = require("mongoose");

/**
 * Opaque cursor pagination.
 *
 * Cursors are base64 ObjectIds rather than skip/limit offsets: offsets shift under
 * concurrent inserts, so a user scrolling an active group's expense list would see
 * duplicates or gaps. An id-anchored cursor is stable.
 */

const encodeCursor = (id) => (id ? Buffer.from(String(id)).toString("base64url") : null);

const decodeCursor = (cursor) => {
  if (!cursor) return null;

  try {
    const decoded = Buffer.from(String(cursor), "base64url").toString("utf8");
    return mongoose.Types.ObjectId.isValid(decoded) ? new mongoose.Types.ObjectId(decoded) : null;
  } catch {
    return null; // A malformed cursor simply starts from the beginning.
  }
};

/**
 * Fetches `limit + 1` rows to detect a further page without a second count query.
 * @param {Array} rows  the over-fetched result set
 */
const buildPage = (rows, limit) => {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    items,
    hasMore,
    nextCursor: hasMore ? encodeCursor(items[items.length - 1]?._id) : null,
  };
};

module.exports = { encodeCursor, decodeCursor, buildPage };
