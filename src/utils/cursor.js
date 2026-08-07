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

/**
 * A cursor for a list sorted by something other than `_id`.
 *
 * ## Why the plain id cursor is not enough
 *
 * `{ _id: { $lt: anchor } }` only walks a list in `_id` order. Sort by amount and
 * the ids are in no particular order, so that filter skips rows and repeats
 * others — a "load more" that quietly loses expenses, which in a money app is the
 * worst kind of bug because nothing looks wrong.
 *
 * So the cursor carries the sort value *and* the id, and the page after it is
 * "strictly past that value, or equal to it and past that id". The id breaks ties,
 * which is what makes the walk total even when fifty expenses share a date.
 */
const encodeKeyCursor = (row, field) => {
  if (!row) return null;
  const raw = row[field];
  const value = raw instanceof Date ? raw.toISOString() : raw;
  return Buffer.from(JSON.stringify({ v: value, id: String(row._id) })).toString("base64url");
};

const decodeKeyCursor = (cursor) => {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!parsed || parsed.id === undefined) return null;
    if (!mongoose.Types.ObjectId.isValid(parsed.id)) return null;

    return { value: parsed.v, id: new mongoose.Types.ObjectId(parsed.id) };
  } catch {
    return null; // Malformed — start from the beginning rather than error.
  }
};

/**
 * The "everything after this point" condition, for a `$and` clause.
 *
 * @param direction -1 for descending, 1 for ascending
 */
const keyCursorFilter = (anchor, field, direction) => {
  if (!anchor) return null;

  const value = typeof anchor.value === "string" && Number.isNaN(Number(anchor.value))
    ? new Date(anchor.value)
    : anchor.value;

  const beyond = direction === -1 ? "$lt" : "$gt";

  return {
    $or: [
      { [field]: { [beyond]: value } },
      { [field]: value, _id: { [beyond]: anchor.id } },
    ],
  };
};

/** `buildPage`, but the cursor is the composite one above. */
const buildKeyPage = (rows, limit, field) => {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    items,
    hasMore,
    nextCursor: hasMore ? encodeKeyCursor(items[items.length - 1], field) : null,
  };
};

module.exports = {
  encodeCursor,
  decodeCursor,
  buildPage,
  encodeKeyCursor,
  decodeKeyCursor,
  keyCursorFilter,
  buildKeyPage,
};
