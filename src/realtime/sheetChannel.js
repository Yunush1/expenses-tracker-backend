const accessService = require("../services/sheetAccessService");
const logger = require("../utils/logger");
const { SHEET_ROLES } = require("../constants");

/**
 * The sheet channel: who is in a sheet, and where their cursor is
 * (docs/20-EXPENSE-SHEETS.md §11).
 *
 * ## Rooms are keyed by sheet id, never by share code
 *
 * The share code is the thing a client sends, and a client-supplied string must
 * never name a room directly: `sheet:<whatever-they-typed>` would let anyone
 * subscribe to a channel by guessing, and — more subtly — would let two different
 * codes for the same sheet become two rooms that never see each other's edits.
 * The code is resolved to a sheet through `sheetAccessService`, access is checked,
 * and only the resolved `_id` names the room.
 *
 * ## Access is checked on join, and again when it changes
 *
 * A socket that has joined holds its membership until it leaves, so revoking
 * someone's access has to actively evict them (`evict`, called from the access
 * service). Otherwise a person removed from a sheet would keep receiving every
 * edit until they happened to reload — which is precisely the "we removed them
 * but they could still see it" failure that makes an access-control feature
 * worthless.
 */

const roomOf = (sheetId) => `sheet:${sheetId}`;

/**
 * Presence, per room, in this process.
 *
 * `Map<roomName, Map<socketId, participant>>`. Deliberately in memory and
 * deliberately **not** in Redis, unlike the broadcast adapter. Presence is
 * ephemeral by definition — it is only true while a socket is connected, and a
 * socket is connected to exactly one process. Putting it in Redis would add a
 * shared store whose entries must then be reaped when a process dies, which is a
 * distributed-systems problem in exchange for a list of avatars.
 *
 * The visible consequence on a multi-instance deployment, stated rather than
 * discovered: `presence:state` on join lists the people on *this* instance, and
 * the rest arrive as they move their cursors, because every cursor message is
 * broadcast through the Redis adapter. Someone who joins and then sits perfectly
 * still is invisible to another instance until they move. For an avatar strip
 * that is an acceptable trade; for anything load-bearing it would not be.
 */
const presence = new Map();

/**
 * A stable colour per person, so the same collaborator is the same colour for
 * everyone looking at the sheet.
 *
 * Derived from the identity rather than assigned on arrival: assigning by join
 * order means two people see each other in different colours, and a reconnect
 * silently reshuffles everybody.
 */
const CURSOR_COLOURS = [
  "#2563eb", "#dc2626", "#059669", "#d97706",
  "#7c3aed", "#db2777", "#0891b2", "#65a30d",
];

const colourFor = (key) => {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return CURSOR_COLOURS[Math.abs(hash) % CURSOR_COLOURS.length];
};

const participantOf = (socket) => {
  const user = socket.data.user;
  // Anonymous viewers of a public sheet are real participants — they are just
  // nameless. Keying their colour on the socket id keeps them distinguishable
  // from each other for as long as they are connected.
  const key = user ? String(user._id) : socket.id;

  return {
    socketId: socket.id,
    userId: user ? String(user._id) : null,
    name: user?.displayName || (user?.email ? user.email.split("@")[0] : "") || "Guest",
    email: user?.email || "",
    colour: colourFor(key),
    /** `{ rowId, columnKey }` — null until they select something. */
    cell: null,
  };
};

const roomPresence = (room) => {
  if (!presence.has(room)) presence.set(room, new Map());
  return presence.get(room);
};

const leaveRoom = (socket) => {
  const room = socket.data.room;
  if (!room) return;

  const members = presence.get(room);
  if (members) {
    members.delete(socket.id);
    if (members.size === 0) presence.delete(room);
  }

  socket.leave(room);
  socket.to(room).emit("presence:leave", { socketId: socket.id });

  socket.data.room = null;
  socket.data.sheetId = null;
  socket.data.role = null;
};

const register = (io) => {
  io.on("connection", (socket) => {
    socket.data.room = null;

    /**
     * Join a sheet. Answers with the caller's own resolved role and everyone
     * already present, so the client needs no second request to render.
     */
    socket.on("sheet:join", async ({ shareCode } = {}, ack) => {
      try {
        if (typeof shareCode !== "string" || !shareCode) {
          return ack?.({ ok: false, error: "A share code is required" });
        }

        // The same resolver the HTTP routes use. A socket must never be a second,
        // laxer way to read a sheet.
        const sheet = await accessService.getSheetByShareCode(shareCode);
        const { role } = await accessService.resolveAccess(sheet, socket.data.user);

        if (!role) return ack?.({ ok: false, error: "No access to this sheet" });

        // One room per socket: a tab shows one sheet, and leaving the old room on
        // switch is what stops a client accumulating subscriptions it no longer
        // renders — every one of which would still cost a broadcast.
        leaveRoom(socket);

        const room = roomOf(sheet._id);
        socket.join(room);
        socket.data.room = room;
        socket.data.sheetId = String(sheet._id);
        socket.data.role = role;

        const me = participantOf(socket);
        const members = roomPresence(room);
        members.set(socket.id, me);

        socket.to(room).emit("presence:join", me);

        return ack?.({
          ok: true,
          role,
          you: me,
          participants: [...members.values()].filter((p) => p.socketId !== socket.id),
        });
      } catch (error) {
        logger.warn(`[realtime] join failed: ${error.message}`);
        return ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("sheet:leave", () => leaveRoom(socket));

    /**
     * "My cursor is here."
     *
     * Broadcast to the room and not persisted anywhere. Note that this is
     * accepted from **viewers** as well as editors: seeing that someone is
     * reading a column is useful, and a cursor grants nothing — it writes no
     * data and is not read by any authorisation decision.
     *
     * The payload is deliberately narrow. It carries ids, never values, so a
     * malicious client cannot use the presence channel to push content into
     * other people's grids.
     */
    socket.on("presence:cursor", ({ rowId, columnKey, range } = {}) => {
      const room = socket.data.room;
      if (!room) return;

      const members = presence.get(room);
      const me = members?.get(socket.id);
      if (!me) return;

      me.cell =
        rowId && columnKey
          ? {
              rowId: String(rowId).slice(0, 64),
              columnKey: String(columnKey).slice(0, 32),
              // Rendered as a translucent block behind another person's
              // selection. Bounded so one client cannot describe a range of a
              // billion cells and make everyone else's renderer walk it.
              rows: Number.isFinite(range?.rows) ? Math.min(range.rows, 500) : 1,
              cols: Number.isFinite(range?.cols) ? Math.min(range.cols, 50) : 1,
            }
          : null;

      socket.to(room).emit("presence:cursor", { socketId: socket.id, cell: me.cell });
    });

    /**
     * "I am editing this cell right now" — sent when an editor opens, cleared on
     * commit. Separate from the cursor because the two mean different things to
     * whoever is watching: a cursor is where somebody *is*, an active edit is a
     * cell whose value is about to change under you.
     */
    socket.on("presence:editing", ({ rowId, columnKey } = {}) => {
      const room = socket.data.room;
      if (!room) return;

      socket.to(room).emit("presence:editing", {
        socketId: socket.id,
        rowId: rowId ? String(rowId).slice(0, 64) : null,
        columnKey: columnKey ? String(columnKey).slice(0, 32) : null,
      });
    });

    /**
     * Share link subscriptions — no auth, code is the permission.
     *
     * The room name is `sharelink:CODE` and anybody holding the code can join. The
     * server broadcasts updates to everyone in the room when the payload changes.
     */
    socket.on("join", ({ room } = {}) => {
      if (room && typeof room === "string" && room.startsWith("sharelink:")) {
        socket.join(room);
      }
    });

    socket.on("leave", ({ room } = {}) => {
      if (room && typeof room === "string") {
        socket.leave(room);
      }
    });

    socket.on("disconnect", () => leaveRoom(socket));
  });
};

/**
 * Throw everyone whose access just disappeared out of the room.
 *
 * Called when a grant is revoked or a sheet is made private again. Re-resolves
 * each socket rather than trusting the role captured at join, because that role
 * is a snapshot and this is the moment it went stale.
 */
const evict = async (io, sheet) => {
  const room = roomOf(sheet._id);

  let sockets;
  try {
    sockets = await io.in(room).fetchSockets();
  } catch (error) {
    logger.warn(`[realtime] Could not enumerate ${room}: ${error.message}`);
    return;
  }

  for (const socket of sockets) {
    // eslint-disable-next-line no-await-in-loop
    const { role } = await accessService.resolveAccess(sheet, socket.data.user);

    if (!role) {
      socket.emit("sheet:access-revoked", { shareCode: sheet.shareCode });
      socket.leave(room);
      presence.get(room)?.delete(socket.id);
      io.to(room).emit("presence:leave", { socketId: socket.id });
      continue;
    }

    /**
     * Still in, but demoted — an editor who is now a viewer. Told rather than
     * silently left with a grid that accepts typing and then 403s on save.
     */
    if (role !== socket.data.role) {
      socket.data.role = role;
      socket.emit("sheet:role-changed", { role });
    }
  }
};

module.exports = { register, roomOf, evict };
