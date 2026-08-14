const crypto = require("crypto");

const Sheet = require("../models/sheet");
const SheetRow = require("../models/sheetRow");
const SheetGrant = require("../models/sheetGrant");
const SheetAccessRequest = require("../models/sheetAccessRequest");
const access = require("./sheetAccessService");
const realtime = require("../realtime/sheetEvents");
const { generateInviteCode } = require("../utils/inviteCode");
const logger = require("../utils/logger");
const {
  DEFAULT_CURRENCY,
  ERROR_CODES,
  LIMITS,
  SHEET_ALIGNMENTS,
  SHEET_COLOUR_PATTERN,
  SHEET_COLUMN_TYPES,
  SHEET_DEFAULT_COLUMNS,
  SHEET_FONTS,
  SHEET_NUMBER_FORMATS,
  SHEET_ROLES,
  SHEET_VALIGN,
} = require("../constants");
const { BadRequestError, ConflictError, ForbiddenError, NotFoundError } = require("../errors");

/**
 * The grid itself — sheets, their columns, and their rows
 * (docs/20-EXPENSE-SHEETS.md §2–3).
 *
 * Not one authorisation decision is made in this file. Every entry point opens
 * with `access.requireAccess(...)`, which returns the sheet and the caller's
 * resolved role or throws; see sheetAccessService for the whole permission model.
 */

const id = (value) => (value ? String(value) : null);

/* -------------------------------- Sheets --------------------------------- */

/**
 * Allocate a share code, retrying on the vanishingly unlikely collision.
 *
 * 96 bits means a collision is not a thing that happens, but `unique: true` on
 * the index means that if one ever did it would surface as a 500 on someone's
 * first action in the product. Three attempts costs nothing and removes the
 * failure mode entirely — the same shape groupService uses for invite codes.
 */
const allocateShareCode = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateInviteCode();
    if (!(await Sheet.exists({ shareCode: code }))) return code;
  }
  throw new ConflictError("Could not allocate a share code. Please try again.");
};

const withKeys = (columns) =>
  columns.map((column) => ({
    key: `c${crypto.randomBytes(4).toString("hex")}`,
    name: column.name,
    type: column.type || SHEET_COLUMN_TYPES.TEXT,
    width: column.width || 160,
    options: column.options || [],
  }));

const createSheet = async (user, { title, description, columns, currency }) => {
  const shareCode = await allocateShareCode();

  /**
   * A caller may bring its own columns — the "duplicate this layout" path — but
   * a sheet with none is created with the defaults rather than as a blank grid.
   * An empty sheet gives no clue what it is for; see SHEET_DEFAULT_COLUMNS.
   */
  const initial = columns?.length ? columns : SHEET_DEFAULT_COLUMNS;

  const sheet = await Sheet.create({
    ownerUserId: user._id,
    title,
    description: description || "",
    shareCode,
    columns: withKeys(initial),
    currency: currency || DEFAULT_CURRENCY,
  });

  /**
   * A brand new sheet gets three empty rows.
   *
   * Cheap, and it removes the worst moment in a grid's life: a header with
   * nothing under it, where the only affordance is a button the user has not
   * looked for yet. Three rows say "type here" without a word of copy.
   */
  await appendRows(sheet, user, [{}, {}, {}]);

  return sheet;
};

/**
 * The top-left corner of a sheet, for the thumbnail on its card.
 *
 * ## Why a slice of real cells rather than a rendered image
 *
 * An image would mean a headless renderer, a storage bucket, and a staleness
 * problem — the thumbnail is wrong the moment anybody types, and re-rendering on
 * every keystroke is absurd. A handful of live cells is always current, costs a
 * few hundred bytes, and the client can draw it as a miniature grid that looks
 * like what it links to.
 *
 * ## Why per-sheet queries rather than one aggregation
 *
 * Grouping rows by sheet and slicing would push every row of every sheet through
 * memory before discarding all but five — on a twenty-thousand-row sheet that is
 * the whole thing, to show four. These are indexed limit-5 reads on
 * `{ sheetId, isDeleted, position }`, run in parallel and capped, so the cost is
 * bounded by the number of *sheets* and not by how big any of them is.
 */
const PREVIEW_ROWS = 4;
const PREVIEW_COLS = 4;
const PREVIEW_SHEET_CAP = 40;
const PREVIEW_CELL_MAX = 24;

const previewFor = async (sheet) => {
  const columns = (sheet.columns || []).slice(0, PREVIEW_COLS);
  if (columns.length === 0) return { headers: [], rows: [] };

  const rows = await SheetRow.find({ sheetId: sheet._id, isDeleted: false })
    .sort({ position: 1 })
    .limit(PREVIEW_ROWS)
    .select("cells")
    .lean();

  return {
    headers: columns.map((column) => column.name),
    // Truncated hard: a cell holding a 500-character note would otherwise be
    // sent in full to render as six clipped pixels on a card.
    rows: rows.map((row) =>
      columns.map((column) => String(row.cells?.[column.key] ?? "").slice(0, PREVIEW_CELL_MAX))
    ),
  };
};

const listSheets = async (user) => {
  const entries = await access.listAccessibleSheets(user);

  const ownedIds = entries
    .filter((entry) => entry.role === SHEET_ROLES.OWNER)
    .map((entry) => entry.sheet._id);

  const pendingCounts = await access.pendingRequestCounts(ownedIds);

  // Beyond the cap the cards are far below the fold anyway, and the query count
  // is what stops mattering last — better a thumbnail-less card than forty
  // round trips nobody scrolled to.
  const previewed = entries.slice(0, PREVIEW_SHEET_CAP);
  const previews = await Promise.all(previewed.map((entry) => previewFor(entry.sheet)));

  return entries.map((entry, index) => ({
    ...entry,
    pendingRequestCount: pendingCounts.get(id(entry.sheet._id)) || 0,
    preview: index < previewed.length ? previews[index] : null,
  }));
};

const getSheet = async (shareCode, user) => {
  const { sheet, role, source } = await access.requireAccess(shareCode, user);
  return { sheet, role, source };
};

const updateSheet = async (shareCode, user, patch, socketId) => {
  /**
   * Title and description are an editor's business; visibility is not.
   *
   * Splitting the required role by *field* rather than by endpoint keeps one
   * update route while making the dangerous half owner-only. An editor renaming a
   * sheet is ordinary collaboration; an editor making a private sheet public is a
   * one-click data disclosure that the owner never agreed to.
   */
  const changesSharing = patch.visibility !== undefined || patch.publicRole !== undefined;

  const { sheet } = await access.requireAccess(
    shareCode,
    user,
    changesSharing ? SHEET_ROLES.OWNER : SHEET_ROLES.EDITOR
  );

  const updates = {};
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.currency !== undefined) updates.currency = patch.currency;
  if (patch.visibility !== undefined) updates.visibility = patch.visibility;
  if (patch.publicRole !== undefined) updates.publicRole = patch.publicRole;
  // Frozen panes are a property of the sheet, not of the viewer — see the model.
  if (patch.frozenRows !== undefined) updates.frozenRows = patch.frozenRows;
  if (patch.frozenCols !== undefined) updates.frozenCols = patch.frozenCols;

  if (Object.keys(updates).length === 0) return sheet;

  updates.lastActivityAt = new Date();

  const updated = await Sheet.findOneAndUpdate({ _id: sheet._id }, { $set: updates }, { new: true });

  if (patch.visibility !== undefined) {
    logger.info(
      `[sheets] ${id(sheet._id)} visibility set to ${patch.visibility} by ${id(user._id)}`
    );
    /**
     * Tightening visibility removes access from people who may be connected
     * right now, and a socket keeps its room membership until it leaves — so
     * they have to be actively evicted rather than merely told.
     */
    realtime.accessChanged(updated);
  }

  realtime.sheetChanged(updated, socketId);

  return updated;
};

/**
 * Delete the sheet, its rows and — crucially — every grant on it.
 *
 * The sheet and rows are soft-deleted so an operator can undo a mistake, but
 * grants are removed outright. If they survived, restoring the sheet would
 * silently restore everyone's access along with it, including people the owner
 * had every intention of losing. Re-sharing on restore is a decision, not a
 * side effect.
 */
const deleteSheet = async (shareCode, user, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.OWNER);

  const now = new Date();

  await Promise.all([
    Sheet.updateOne({ _id: sheet._id }, { $set: { isDeleted: true, deletedAt: now } }),
    SheetRow.updateMany(
      { sheetId: sheet._id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: now } }
    ),
    SheetGrant.deleteMany({ sheetId: sheet._id }),
    SheetAccessRequest.deleteMany({ sheetId: sheet._id }),
  ]);

  // Everyone still looking at it has just lost access to something that no
  // longer exists — evicted rather than left holding a grid that 404s on save.
  sheet.isDeleted = true;
  realtime.accessChanged(sheet);

  return { id: id(sheet._id), title: sheet.title };
};

/* -------------------------------- Columns -------------------------------- */

const findColumn = (sheet, columnKey) => {
  const column = sheet.columns.find((entry) => entry.key === columnKey);
  if (!column) {
    throw new NotFoundError("That column no longer exists.", ERROR_CODES.SHEET_COLUMN_NOT_FOUND);
  }
  return column;
};

const addColumn = async (
  shareCode,
  user,
  { name, type, width, options, afterKey, beforeKey },
  socketId
) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.EDITOR);

  if (sheet.columns.length >= LIMITS.SHEET_MAX_COLUMNS) {
    throw new ConflictError(
      `A sheet can have at most ${LIMITS.SHEET_MAX_COLUMNS} columns.`,
      ERROR_CODES.SHEET_LIMIT_REACHED
    );
  }

  const [column] = withKeys([{ name, type, width, options }]);

  // Inserted where the user clicked "insert left"/"insert right", appended
  // otherwise. The array's order *is* the display order — there is no separate
  // index to keep in step with it, and therefore none to fall out of step.
  //
  // A key naming a column that is no longer there falls through to the append,
  // which is the right answer for a menu opened just before somebody else
  // deleted that column: the request is odd but not wrong, and refusing it would
  // lose the user's column to a race they cannot see.
  const before = beforeKey ? sheet.columns.findIndex((entry) => entry.key === beforeKey) : -1;
  const after = afterKey ? sheet.columns.findIndex((entry) => entry.key === afterKey) : -1;

  if (before >= 0) sheet.columns.splice(before, 0, column);
  else if (after >= 0) sheet.columns.splice(after + 1, 0, column);
  else sheet.columns.push(column);

  sheet.lastActivityAt = new Date();
  realtime.sheetChanged(sheet, socketId);
  await sheet.save();


  return { sheet, column };
};

/**
 * Rename, retype, resize or reorder a column.
 *
 * None of this touches a single row, because cells are keyed by the column's
 * immutable `key` rather than its name (models/sheet.js). Renaming forty columns
 * on a twenty-thousand-row sheet is forty field writes on one document.
 */
const updateColumn = async (shareCode, user, columnKey, patch, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.EDITOR);

  const column = findColumn(sheet, columnKey);

  if (patch.name !== undefined) column.name = patch.name;
  if (patch.type !== undefined) column.type = patch.type;
  if (patch.width !== undefined) column.width = patch.width;
  if (patch.options !== undefined) column.options = patch.options;

  if (patch.position !== undefined) {
    const from = sheet.columns.findIndex((entry) => entry.key === columnKey);
    const to = Math.max(0, Math.min(patch.position, sheet.columns.length - 1));
    const [moved] = sheet.columns.splice(from, 1);
    sheet.columns.splice(to, 0, moved);
  }

  sheet.lastActivityAt = new Date();
  await sheet.save();

  realtime.sheetChanged(sheet, socketId);

  return sheet;
};

/**
 * Remove a column from the sheet — and deliberately leave its cells behind.
 *
 * The rows keep their values under a key nothing reads any more, which costs a
 * little storage and buys the undo: re-adding a column with the same key brings
 * the data back. Sweeping them would be a `$unset` across every row in the sheet
 * to reclaim bytes nobody is short of, and would make the commonest destructive
 * mistake in a spreadsheet permanent. Reads filter to the live columns
 * (`cellsOf`), so nothing stale is ever returned.
 */
const deleteColumn = async (shareCode, user, columnKey, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.EDITOR);

  findColumn(sheet, columnKey);

  if (sheet.columns.length === 1) {
    throw new BadRequestError("A sheet needs at least one column.");
  }

  sheet.columns = sheet.columns.filter((entry) => entry.key !== columnKey);
  sheet.lastActivityAt = new Date();
  await sheet.save();

  realtime.sheetChanged(sheet, socketId);

  return sheet;
};

/* ------------------------------- Protection ------------------------------- */

/**
 * Refuse a write that lands inside a protected range.
 *
 * ## This is the lock. The padlock in the UI is decoration.
 *
 * A client-side check stops an honest editor from typing where they should not,
 * and stops nobody else: the API is a documented HTTP endpoint, and "can this
 * person change this number" is exactly the kind of question that must be
 * answered where the data lives. So every cell in every write is checked here.
 *
 * ## Who is exempt
 *
 * The owner, always and implicitly — a lock the owner could lock themselves out
 * of is a trap, and there is no second owner to undo it. Plus anyone explicitly
 * named in `allowedUserIds`, which is what makes "finance owns this column, and
 * Priya can also edit it" expressible.
 *
 * Note that this is checked *after* `requireAccess` has already established
 * EDITOR: protection narrows an existing permission, it never grants one. A
 * viewer named in `allowedUserIds` still cannot write, because they never got
 * past the role check.
 */
const rangeCovers = (range, rowId, columnKey) => {
  if (!range.columnKeys.includes(columnKey)) return false;
  if (range.allRows) return true;
  return range.rowIds.includes(String(rowId));
};

const assertWritable = (sheet, user, rowId, columnKeys) => {
  if (sheet.protectedRanges.length === 0) return;
  if (id(sheet.ownerUserId) === id(user._id)) return;

  for (const range of sheet.protectedRanges) {
    const allowed = (range.allowedUserIds || []).some((entry) => id(entry) === id(user._id));
    if (allowed) continue;

    const blocked = columnKeys.find((columnKey) => rangeCovers(range, rowId, columnKey));
    if (!blocked) continue;

    const column = sheet.columns.find((entry) => entry.key === blocked);

    throw new ForbiddenError(
      range.label
        ? `"${range.label}" is locked by the owner.`
        : `${column ? `The ${column.name} column` : "That cell"} is locked by the owner.`,
      ERROR_CODES.SHEET_RANGE_LOCKED
    );
  }
};

/** Owner-only: lock a set of cells. */
const protectRange = async (shareCode, user, { label, columnKeys, rowIds, allRows, allowedUserIds }, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.OWNER);

  if (sheet.protectedRanges.length >= LIMITS.SHEET_MAX_PROTECTED_RANGES) {
    throw new ConflictError(
      `A sheet can have at most ${LIMITS.SHEET_MAX_PROTECTED_RANGES} protected ranges.`,
      ERROR_CODES.SHEET_LIMIT_REACHED
    );
  }

  // Unknown column keys are dropped rather than rejected: a range referring to a
  // column somebody deleted mid-request is a race, not a bad request, and the
  // useful outcome is to protect what still exists.
  const live = new Set(sheet.columns.map((column) => column.key));
  const keys = (columnKeys || []).filter((key) => live.has(key));
  if (keys.length === 0) throw new BadRequestError("Select at least one column to lock.");

  sheet.protectedRanges.push({
    label: label || "",
    columnKeys: keys,
    rowIds: allRows ? [] : (rowIds || []).map(String),
    allRows: Boolean(allRows),
    allowedUserIds: allowedUserIds || [],
    createdByUserId: user._id,
  });

  sheet.lastActivityAt = new Date();
  await sheet.save();

  realtime.sheetChanged(sheet, socketId);
  return sheet;
};

const unprotectRange = async (shareCode, user, rangeId, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.OWNER);

  const before = sheet.protectedRanges.length;
  sheet.protectedRanges = sheet.protectedRanges.filter((range) => range.id !== rangeId);
  if (sheet.protectedRanges.length === before) {
    throw new NotFoundError("That locked range no longer exists.", ERROR_CODES.SHEET_NOT_FOUND);
  }

  sheet.lastActivityAt = new Date();
  await sheet.save();

  realtime.sheetChanged(sheet, socketId);
  return sheet;
};

/* ---------------------------------- Rows --------------------------------- */

/** Only cells belonging to a live column. See deleteColumn for why they can differ. */
const cellsOf = (row, sheet) => {
  const live = new Set(sheet.columns.map((column) => column.key));
  const out = {};

  // A lean() row has a plain object; a hydrated one has a Map. Both appear here.
  const entries = row.cells instanceof Map ? row.cells.entries() : Object.entries(row.cells || {});
  for (const [key, value] of entries) {
    if (live.has(key)) out[key] = value;
  }

  return out;
};

/** Formatting for the live columns only, in the same shape `cellsOf` returns values. */
const formatsOf = (row, sheet) => {
  const live = new Set(sheet.columns.map((column) => column.key));
  const out = {};

  const entries =
    row.formats instanceof Map ? row.formats.entries() : Object.entries(row.formats || {});
  for (const [key, value] of entries) {
    if (live.has(key) && value && Object.keys(value).length > 0) out[key] = value;
  }

  return out;
};

/**
 * Whitelist a cell's formatting.
 *
 * Every field is checked against a fixed set, and colours against a strict
 * `#rrggbb` pattern — because these values become **CSS in other people's
 * browsers**. A free-text colour is an injection surface: `red;background:url(...)`
 * and worse are what an unchecked string in a `style` attribute buys, and the
 * sheet is shared, so the payload would be served to every collaborator.
 * Constraining the value to a shape that cannot express a second declaration
 * makes that impossible rather than merely unlikely.
 *
 * Note this runs on **every** write path, including the realtime one — a colour
 * that never passed through the toolbar is checked identically.
 *
 * Falsy flags are dropped rather than stored as `false`, so a cell that was bold
 * and is no longer stores nothing at all instead of accumulating a row of
 * negatives. A format object that ends up empty means "clear this cell's
 * formatting" to the writer above.
 */
const sanitiseFormats = (formats, sheet) => {
  const live = new Set(sheet.columns.map((column) => column.key));
  const out = {};

  for (const [key, raw] of Object.entries(formats || {})) {
    if (!live.has(key) || !raw || typeof raw !== "object") continue;

    const format = {};

    for (const flag of ["b", "i", "u", "s", "wrap"]) {
      if (raw[flag]) format[flag] = true;
    }

    // Lowercased on the way in so the same colour picked from a swatch and typed
    // by hand compares equal downstream.
    if (typeof raw.fg === "string" && SHEET_COLOUR_PATTERN.test(raw.fg)) {
      format.fg = raw.fg.toLowerCase();
    }
    if (typeof raw.bg === "string" && SHEET_COLOUR_PATTERN.test(raw.bg)) {
      format.bg = raw.bg.toLowerCase();
    }
    if (Object.values(SHEET_ALIGNMENTS).includes(raw.align)) format.align = raw.align;
    if (Object.values(SHEET_VALIGN).includes(raw.valign)) format.valign = raw.valign;
    if (Object.values(SHEET_NUMBER_FORMATS).includes(raw.nf)) format.nf = raw.nf;

    // "Default" is the absence of a choice, so it is dropped rather than stored —
    // the same reason falsy flags above are not kept as `false`.
    if (typeof raw.font === "string" && raw.font !== "Default" && SHEET_FONTS.includes(raw.font)) {
      format.font = raw.font;
    }

    const size = Number(raw.size);
    if (
      Number.isFinite(size) &&
      size >= LIMITS.SHEET_FONT_SIZE_MIN &&
      size <= LIMITS.SHEET_FONT_SIZE_MAX
    ) {
      format.size = Math.round(size);
    }

    // Decimal places. Bounded rather than free, because this drives a
    // `toFixed`-shaped call on the client and a large value is a way to make
    // every collaborator's grid render nonsense.
    const decimals = Number(raw.dp);
    if (Number.isFinite(decimals) && decimals >= 0 && decimals <= LIMITS.SHEET_DECIMALS_MAX) {
      format.dp = Math.round(decimals);
    }

    out[key] = format;
  }

  return out;
};

/** Drop unknown keys and over-long values before anything is written. */
const sanitiseCells = (cells, sheet) => {
  const live = new Set(sheet.columns.map((column) => column.key));
  const out = {};

  for (const [key, value] of Object.entries(cells || {})) {
    if (!live.has(key)) continue;
    if (value === null || value === undefined) continue;
    out[key] = String(value).slice(0, LIMITS.SHEET_CELL_MAX);
  }

  return out;
};

/**
 * Append rows at the end — the fast path, and the one paste uses.
 *
 * `positionCursor` is advanced with a single atomic `$inc`, so N rows get N
 * contiguous slots without reading what is already there. Two people pasting
 * simultaneously get disjoint ranges rather than colliding positions.
 */
const appendRows = async (sheet, user, rows) => {
  const count = rows.length;
  if (count === 0) return [];

  const bumped = await Sheet.findOneAndUpdate(
    { _id: sheet._id },
    {
      $inc: { positionCursor: LIMITS.SHEET_POSITION_STEP * count, rowCount: count },
      $set: { lastActivityAt: new Date() },
    },
    { new: true }
  );

  // The block this call reserved: the cursor now points past it, so subtracting
  // gives the first slot that belongs to us.
  const base = bumped.positionCursor - LIMITS.SHEET_POSITION_STEP * count;

  const docs = rows.map((row, index) => ({
    sheetId: sheet._id,
    position: base + LIMITS.SHEET_POSITION_STEP * (index + 1),
    cells: sanitiseCells(row.cells, sheet),
    createdByUserId: user._id,
    updatedByUserId: user._id,
  }));

  return SheetRow.insertMany(docs);
};

/**
 * Restore even gaps between rows.
 *
 * Called only when an insert has nowhere left to go — see models/sheetRow.js for
 * how a run of inserts at one spot exhausts the space between two doubles. It
 * rewrites every row's position in one bulk operation, which is expensive and
 * therefore something to arrive at rarely rather than schedule.
 */
const rebalance = async (sheetId) => {
  const rows = await SheetRow.find({ sheetId, isDeleted: false })
    .sort({ position: 1 })
    .select("_id")
    .lean();

  if (rows.length === 0) return;

  const operations = rows.map((row, index) => ({
    updateOne: {
      filter: { _id: row._id },
      update: { $set: { position: LIMITS.SHEET_POSITION_STEP * (index + 1) } },
    },
  }));

  await SheetRow.bulkWrite(operations, { ordered: false });
  await Sheet.updateOne(
    { _id: sheetId },
    { $set: { positionCursor: LIMITS.SHEET_POSITION_STEP * rows.length } }
  );

  logger.info(`[sheets] Rebalanced ${rows.length} row positions on ${id(sheetId)}`);
};

/** The midpoint between a row and the one above it, rebalancing if there is no room. */
const positionBefore = async (sheetId, beforeRow) => {
  const previous = await SheetRow.findOne({
    sheetId,
    isDeleted: false,
    position: { $lt: beforeRow.position },
  })
    .sort({ position: -1 })
    .select("position")
    .lean();

  const lower = previous ? previous.position : 0;
  const gap = beforeRow.position - lower;

  /**
   * A gap below 1 cannot be halved into two distinguishable doubles any more.
   * Rebalance, then re-read: after that there is a full step to work with.
   */
  if (gap < 1) {
    await rebalance(sheetId);
    const refreshed = await SheetRow.findById(beforeRow._id).select("position").lean();
    return positionBefore(sheetId, refreshed);
  }

  return lower + gap / 2;
};

const listRows = async (shareCode, user, { cursor, limit }) => {
  const { sheet, role, source } = await access.requireAccess(shareCode, user);

  const query = { sheetId: sheet._id, isDeleted: false };
  // Position is the cursor: it is the sort key, it is unique in practice, and it
  // is stable across inserts elsewhere in the sheet — so paging cannot skip or
  // repeat a row the way an offset would.
  if (cursor !== undefined && cursor !== null && cursor !== "") {
    query.position = { $gt: Number(cursor) };
  }

  const rows = await SheetRow.find(query)
    .sort({ position: 1 })
    .limit(limit + 1)
    .lean();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    sheet,
    role,
    source,
    rows: page.map((row) => ({ ...row, cells: cellsOf(row, sheet), formats: formatsOf(row, sheet) })),
    nextCursor: hasMore ? String(page[page.length - 1].position) : null,
  };
};

/**
 * Add rows: appended, or inserted above a given row.
 *
 * This is the clipboard-paste endpoint as well as the "+ row" button — the same
 * operation with a different row count, so there is one code path and not two
 * that drift.
 */
const createRows = async (shareCode, user, { rows, beforeRowId }, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.EDITOR);

  if (rows.length > LIMITS.SHEET_MAX_BULK_ROWS) {
    throw new BadRequestError(
      `Up to ${LIMITS.SHEET_MAX_BULK_ROWS} rows can be added at once.`
    );
  }

  const current = await SheetRow.countDocuments({ sheetId: sheet._id, isDeleted: false });
  if (current + rows.length > LIMITS.SHEET_MAX_ROWS) {
    throw new ConflictError(
      `A sheet can hold at most ${LIMITS.SHEET_MAX_ROWS.toLocaleString()} rows.`,
      ERROR_CODES.SHEET_LIMIT_REACHED
    );
  }

  if (!beforeRowId) {
    const created = await appendRows(sheet, user, rows);
    const dtos = created.map((row) => ({ ...row.toObject(), cells: cellsOf(row, sheet), formats: formatsOf(row, sheet) }));
    realtime.rowsAdded(sheet._id, dtos, socketId);
    return { sheet, rows: dtos };
  }

  const anchor = await SheetRow.findOne({ _id: beforeRowId, sheetId: sheet._id, isDeleted: false });
  if (!anchor) throw new NotFoundError("That row no longer exists.", ERROR_CODES.SHEET_ROW_NOT_FOUND);

  /**
   * Inserted one at a time, each taking the midpoint above the previous
   * insertion, so a multi-row insert lands in the order it was given. Bounded by
   * SHEET_MAX_BULK_ROWS; the overwhelmingly common case is a single row.
   */
  const created = [];
  let anchorRow = anchor;

  for (const row of rows) {
    const position = await positionBefore(sheet._id, anchorRow);
    const doc = await SheetRow.create({
      sheetId: sheet._id,
      position,
      cells: sanitiseCells(row.cells, sheet),
      createdByUserId: user._id,
      updatedByUserId: user._id,
    });
    created.push(doc);
    // The next row goes above the anchor but below the one just written, which
    // is what preserves the caller's ordering.
    anchorRow = doc;
  }

  await Sheet.updateOne(
    { _id: sheet._id },
    { $inc: { rowCount: created.length }, $set: { lastActivityAt: new Date() } }
  );

  const dtos = created.map((row) => ({ ...row.toObject(), cells: cellsOf(row, sheet), formats: formatsOf(row, sheet) }));
  realtime.rowsAdded(sheet._id, dtos, socketId);

  return { sheet, rows: dtos };
};

/**
 * Write cells into one row.
 *
 * ## Why the update is per-cell rather than a whole-row replace
 *
 * `$set` on `cells.<key>` touches only the columns in the payload. Two people
 * editing different columns of the same row therefore both succeed, which is the
 * normal case in a shared grid and would otherwise be a lost update every time.
 *
 * ## And why `version` still guards it
 *
 * Because two people editing the *same* cell is a real conflict, and silently
 * keeping the later write is how a number nobody typed ends up in an expense
 * report. The client sends the version it read; a mismatch is a 409 and the grid
 * refetches the row rather than guessing.
 */
const updateRow = async (shareCode, user, rowId, { cells, formats, version }, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.EDITOR);

  const clean = sanitiseCells(cells, sheet);
  const cleanFormats = sanitiseFormats(formats, sheet);

  // The lock, enforced where it means something. Covers formatting as well as
  // values: repainting a locked cell black-on-black is a way of destroying it
  // without changing a character.
  assertWritable(sheet, user, rowId, [
    ...Object.keys(clean),
    ...Object.keys(cleanFormats),
  ]);

  const updates = {};
  for (const [key, value] of Object.entries(clean)) {
    updates[`cells.${key}`] = value;
  }

  /**
   * An empty string clears a cell rather than storing "". Kept as a `$unset` so
   * a cleared cell is genuinely absent — otherwise a sheet accumulates a thousand
   * empty strings per deleted value, and "has this ever been filled in?" stops
   * being answerable.
   */
  const unsets = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === "") {
      delete updates[key];
      unsets[key] = "";
    }
  }

  /**
   * Formatting, merged per cell rather than replaced.
   *
   * `$set` on `formats.<key>` writes the whole object for that cell, so the
   * caller sends the merged result — the client holds the current format anyway
   * in order to render it, and a read-modify-write on the server would need a
   * second round trip to do worse. An empty object clears the cell's formatting
   * entirely, which is what the "clear formatting" button sends.
   */
  for (const [key, format] of Object.entries(cleanFormats)) {
    if (Object.keys(format).length === 0) unsets[`formats.${key}`] = "";
    else updates[`formats.${key}`] = format;
  }

  const updated = await SheetRow.findOneAndUpdate(
    { _id: rowId, sheetId: sheet._id, isDeleted: false, version },
    {
      ...(Object.keys(updates).length ? { $set: { ...updates, updatedByUserId: user._id } } : { $set: { updatedByUserId: user._id } }),
      ...(Object.keys(unsets).length ? { $unset: unsets } : {}),
      $inc: { version: 1 },
    },
    { new: true }
  );

  if (!updated) {
    // Tell the two failures apart: a deleted row and a stale version need
    // different things from the client (drop it, or refetch and retry).
    const exists = await SheetRow.findOne({ _id: rowId, sheetId: sheet._id, isDeleted: false })
      .select("version")
      .lean();

    if (!exists) {
      throw new NotFoundError("That row was deleted.", ERROR_CODES.SHEET_ROW_NOT_FOUND);
    }

    throw new ConflictError(
      "Someone else changed this row while you were editing it.",
      ERROR_CODES.VERSION_CONFLICT
    );
  }

  await access.touch(sheet._id);

  const dto = { ...updated.toObject(), cells: cellsOf(updated, sheet), formats: formatsOf(updated, sheet) };

  // After the write, never before: a broadcast is a statement that something
  // already happened. See realtime/sheetEvents.js.
  realtime.rowUpdated(sheet._id, dto, socketId);

  return dto;
};

const deleteRows = async (shareCode, user, rowIds, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.EDITOR);

  const result = await SheetRow.updateMany(
    { _id: { $in: rowIds }, sheetId: sheet._id, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date(), updatedByUserId: user._id } }
  );

  if (result.modifiedCount > 0) {
    await Sheet.updateOne(
      { _id: sheet._id },
      { $inc: { rowCount: -result.modifiedCount }, $set: { lastActivityAt: new Date() } }
    );
    realtime.rowsDeleted(sheet._id, rowIds.map(String), socketId);
  }

  return { deletedCount: result.modifiedCount };
};

/**
 * Move a row to sit above another — drag-and-drop reordering.
 *
 * Only `position` changes, so the row keeps its identity, its history and its
 * version. Reordering by rewriting cells would be a different row wearing the
 * same values.
 */
const moveRow = async (shareCode, user, rowId, { beforeRowId }, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.EDITOR);

  const row = await SheetRow.findOne({ _id: rowId, sheetId: sheet._id, isDeleted: false });
  if (!row) throw new NotFoundError("That row no longer exists.", ERROR_CODES.SHEET_ROW_NOT_FOUND);

  let position;

  if (!beforeRowId) {
    // To the very end: past everything, using the same cursor append uses.
    const bumped = await Sheet.findOneAndUpdate(
      { _id: sheet._id },
      { $inc: { positionCursor: LIMITS.SHEET_POSITION_STEP }, $set: { lastActivityAt: new Date() } },
      { new: true }
    );
    position = bumped.positionCursor;
  } else {
    const anchor = await SheetRow.findOne({
      _id: beforeRowId,
      sheetId: sheet._id,
      isDeleted: false,
    });
    if (!anchor) throw new NotFoundError("That row no longer exists.", ERROR_CODES.SHEET_ROW_NOT_FOUND);
    position = await positionBefore(sheet._id, anchor);
  }

  row.position = position;
  row.updatedByUserId = user._id;
  await row.save();

  const dto = { ...row.toObject(), cells: cellsOf(row, sheet), formats: formatsOf(row, sheet) };
  realtime.rowMoved(sheet._id, dto, socketId);

  return dto;
};

/**
 * Reorder every row by one column's values — a real sort, written to the server.
 *
 * ## Why this is not a client-side view
 *
 * Row order is *shared*. A sheet has one order, everybody sees it, and
 * `position` is what defines it (models/sheetRow.js). A local-only sort would
 * mean two people looking at different orders while both talk about "row 12",
 * and any insert would land somewhere unpredictable for the other person. So
 * sorting rewrites positions for everyone — which also means it is an edit, and
 * requires EDITOR.
 *
 * Filtering, by contrast, genuinely is a per-person view and stays on the client:
 * hiding rows changes nothing about the data.
 */
const sortRows = async (shareCode, user, { columnKey, direction = "asc" }, socketId) => {
  const { sheet } = await access.requireAccess(shareCode, user, SHEET_ROLES.EDITOR);
  findColumn(sheet, columnKey);

  const rows = await SheetRow.find({ sheetId: sheet._id, isDeleted: false })
    .sort({ position: 1 })
    .lean();

  /**
   * Numbers sort numerically, everything else as case-insensitive text, and
   * blanks always sink to the bottom regardless of direction.
   *
   * That last rule is the one worth stating: in ascending order an empty string
   * sorts before everything, so a sheet with half its rows unfilled opens with a
   * screen of blanks and the data pushed out of sight. Every spreadsheet treats
   * empties as "no value" rather than as the smallest value, and so does this.
   */
  const valueOf = (row) => (row.cells?.[columnKey] ?? "").toString().trim();

  const compare = (a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);

    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;

    const leftNumber = Number(left.replace(/[₹$€£¥,\s]/g, ""));
    const rightNumber = Number(right.replace(/[₹$€£¥,\s]/g, ""));
    const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);

    const result = bothNumeric
      ? leftNumber - rightNumber
      : left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

    return direction === "desc" ? -result : result;
  };

  const sorted = [...rows].sort(compare);

  await SheetRow.bulkWrite(
    sorted.map((row, index) => ({
      updateOne: {
        filter: { _id: row._id },
        update: { $set: { position: LIMITS.SHEET_POSITION_STEP * (index + 1) } },
      },
    })),
    { ordered: false }
  );

  await Sheet.updateOne(
    { _id: sheet._id },
    {
      $set: {
        positionCursor: LIMITS.SHEET_POSITION_STEP * sorted.length,
        lastActivityAt: new Date(),
      },
    }
  );

  const fresh = await SheetRow.find({ sheetId: sheet._id, isDeleted: false })
    .sort({ position: 1 })
    .lean();

  const dtos = fresh.map((row) => ({
    ...row,
    cells: cellsOf(row, sheet),
    formats: formatsOf(row, sheet),
  }));

  /**
   * A whole-sheet reorder is broadcast as "refetch", not as N row-moved events.
   * Every row's position changed, and streaming them would have collaborators
   * rendering a partially-sorted grid as the messages arrived.
   */
  realtime.rowsReordered(sheet._id, socketId);

  return { rows: dtos };
};

module.exports = {
  protectRange,
  unprotectRange,
  assertWritable,
  sortRows,
  createSheet,
  listSheets,
  getSheet,
  updateSheet,
  deleteSheet,
  addColumn,
  updateColumn,
  deleteColumn,
  listRows,
  createRows,
  updateRow,
  deleteRows,
  moveRow,
  rebalance,
  cellsOf,
};
