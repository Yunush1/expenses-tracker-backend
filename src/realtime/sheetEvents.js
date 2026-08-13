const { getIo } = require("./io");
const { roomOf, evict } = require("./sheetChannel");
const { toRowDTO } = require("../serializers/sheetSerializer");
const logger = require("../utils/logger");

/**
 * What the server tells a sheet's room after a write has already succeeded
 * (docs/20-EXPENSE-SHEETS.md §11).
 *
 * ## Every function here is fire-and-forget, and that is the contract
 *
 * They are called from `sheetService` *after* the database write has committed
 * and the HTTP response is effectively decided. A failure to broadcast must
 * therefore never propagate: the edit is saved, and the only consequence of a
 * lost message is that somebody else's grid stays stale until its next fetch —
 * exactly where the product was before real-time existed. So every emit is
 * wrapped, and `getIo()` being null (real-time unavailable, or not configured)
 * is an ordinary no-op rather than a branch every caller has to remember.
 *
 * ## Why the originating socket is excluded
 *
 * The client that made the edit has already applied it optimistically
 * (`useRowSaver`). Echoing it back would overwrite the local echo with a value
 * that is identical *unless* the person has typed again in the meantime — in
 * which case it silently reverts their newer keystrokes. The client passes its
 * socket id as `X-Socket-Id`, which is threaded down to here.
 */

const emit = (sheetId, event, payload, exceptSocketId) => {
  const io = getIo();
  if (!io) return;

  try {
    const room = roomOf(sheetId);
    // `io.except()` reaches sockets on every instance via the Redis adapter;
    // `socket.to()` would only work if we held the sender's socket object, which
    // an HTTP handler does not.
    if (exceptSocketId) io.to(room).except(exceptSocketId).emit(event, payload);
    else io.to(room).emit(event, payload);
  } catch (error) {
    logger.warn(`[realtime] Could not emit ${event}: ${error.message}`);
  }
};

/**
 * Rows go out through the **same serializer as the HTTP response**, and that is
 * not a tidiness point.
 *
 * The service hands these a raw Mongoose object, whose id is `_id`. Clients index
 * rows by `id` — so an unserialized broadcast matches nothing in the cache, and
 * `useSheetRealtime` correctly concludes it is looking at a row it has never seen
 * and *appends* it. A collaborator typing in one cell then makes a duplicate row
 * appear in everyone else's grid instead of updating theirs, and nothing anywhere
 * reports an error.
 *
 * The rule this encodes: a socket payload is part of the API contract, so it goes
 * through the serializer exactly as a response body does.
 */
const rowUpdated = (sheetId, row, exceptSocketId) =>
  emit(sheetId, "sheet:row-updated", { row: toRowDTO(row) }, exceptSocketId);

/** Rows appended or inserted. Carries them in full so the client need not refetch. */
const rowsAdded = (sheetId, rows, exceptSocketId) =>
  emit(sheetId, "sheet:rows-added", { rows: rows.map(toRowDTO) }, exceptSocketId);

const rowsDeleted = (sheetId, rowIds, exceptSocketId) =>
  emit(sheetId, "sheet:rows-deleted", { rowIds: rowIds.map(String) }, exceptSocketId);

const rowMoved = (sheetId, row, exceptSocketId) =>
  emit(sheetId, "sheet:row-moved", { row: toRowDTO(row) }, exceptSocketId);

/**
 * Every row's position changed at once — a sort.
 *
 * Carries no rows on purpose. Streaming a few thousand moved rows would have
 * collaborators rendering a half-sorted grid as the messages landed, and the
 * payload would dwarf a plain refetch. "Look again" is both smaller and more
 * correct.
 */
const rowsReordered = (sheetId, exceptSocketId) =>
  emit(sheetId, "sheet:rows-reordered", {}, exceptSocketId);

/**
 * The sheet's own shape changed — title, columns, visibility.
 *
 * One event for all three rather than three, because the client's response is
 * identical in every case: merge these fields into the sheet it holds. Columns in
 * particular must arrive as a whole list; a "column added" delta would have to
 * carry its position, and the array's order *is* the position.
 *
 * ## Why this is not the sheet DTO
 *
 * `toSheetDTO` stamps `role`, `canEdit`, `isOwner` and `pendingRequestCount` onto
 * the sheet — and every one of those is **per recipient**. A broadcast has one
 * payload and many recipients, so sending the DTO would tell every viewer in the
 * room that they hold the *editor's* role: a privilege escalation invented by a
 * notification, and one the client would happily render as an editable grid until
 * the first save came back 403.
 *
 * So the payload is built here, explicitly, from the fields that mean the same
 * thing to everybody. The client merges them and keeps its own role untouched.
 * Anything added to the sheet model later must be considered against that rule
 * before it is added to this list.
 */
const sheetChanged = (sheet, exceptSocketId) =>
  emit(
    sheet._id,
    "sheet:changed",
    {
      sheet: {
        id: String(sheet._id),
        title: sheet.title,
        description: sheet.description || "",
        shareCode: sheet.shareCode,
        columns: (sheet.columns || []).map((column) => ({
          key: column.key,
          name: column.name,
          type: column.type,
          width: column.width,
          options: column.options || [],
        })),
        visibility: sheet.visibility,
        publicRole: sheet.publicRole,
        currency: sheet.currency,
        frozenRows: sheet.frozenRows || 0,
        frozenCols: sheet.frozenCols || 0,
        /**
         * Safe to broadcast, and necessary: the padlock has to appear on
         * everyone's grid the moment a range is locked, not on their next
         * reload. It describes *which cells* are restricted, never who may edit
         * them — `allowedUserIds` is stripped by the serializer for exactly the
         * reason `role` is stripped from this payload.
         */
        protectedRanges: (sheet.protectedRanges || []).map((range) => ({
          id: range.id,
          label: range.label || "",
          columnKeys: range.columnKeys || [],
          rowIds: (range.rowIds || []).map(String),
          allRows: Boolean(range.allRows),
        })),
        rowCount: sheet.rowCount || 0,
        lastActivityAt: sheet.lastActivityAt,
      },
    },
    exceptSocketId
  );

/**
 * Access changed: somebody was removed, or the sheet went private.
 *
 * Unlike the others this is not merely a notification — it re-checks every
 * connected socket and throws out the ones that no longer qualify. A socket keeps
 * its room membership until it leaves, so without this a revoked collaborator
 * would keep receiving every edit until they happened to reload.
 */
const accessChanged = (sheet) => {
  const io = getIo();
  if (!io) return;

  evict(io, sheet).catch((error) =>
    logger.warn(`[realtime] Eviction sweep failed for ${sheet._id}: ${error.message}`)
  );
};

/**
 * Somebody asked for access — tell the **owner only**.
 *
 * Deliberately not a room broadcast. The room holds every viewer and editor, and
 * a request carries the asker's name and email address; announcing it to the room
 * would hand one person's address to everyone who happens to have the sheet open,
 * to no benefit — nobody but the owner can act on it.
 *
 * So this carries no payload at all beyond "look again". The owner's client
 * refetches the owner-only access endpoint, which is the single place that
 * decides what those details are and who may see them. A notification that
 * contains nothing cannot leak anything.
 */
const accessRequested = (sheet) => {
  const io = getIo();
  if (!io) return;

  notifyOwner(io, sheet).catch((error) =>
    logger.warn(`[realtime] Could not notify the owner of ${sheet._id}: ${error.message}`)
  );
};

const notifyOwner = async (io, sheet) => {
  const sockets = await io.in(roomOf(sheet._id)).fetchSockets();
  const ownerId = String(sheet.ownerUserId);

  for (const socket of sockets) {
    if (socket.data?.user && String(socket.data.user._id) === ownerId) {
      socket.emit("sheet:access-requested");
    }
  }
};

module.exports = {
  rowUpdated,
  rowsAdded,
  rowsDeleted,
  rowMoved,
  rowsReordered,
  sheetChanged,
  accessChanged,
  accessRequested,
};
