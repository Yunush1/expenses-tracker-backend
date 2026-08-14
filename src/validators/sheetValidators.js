const { z } = require("zod");
const { objectId, trimmedString } = require("./common");
const {
  DEFAULT_SHEET_TITLE,
  LIMITS,
  SHEET_ALIGNMENTS,
  SHEET_COLUMN_TYPES,
  SHEET_NUMBER_FORMATS,
  SHEET_VALIGN,
  SHEET_GRANTABLE_ROLES,
  SHEET_VISIBILITY,
  SHEET_ROLES,
} = require("../constants");

/**
 * Shape only, as everywhere else in this API. Who may do what lives in
 * sheetAccessService, and what a value has to *mean* lives in sheetService — so
 * there is one set of rules rather than two that drift.
 */

/**
 * An address, normalised at the boundary.
 *
 * Lowercased here rather than in the service because it is the lookup key for
 * every grant (models/sheetGrant.js): `Priya@Acme.com` and `priya@acme.com` must
 * be the same row, or the unique index would happily hold both and the second
 * invitation would silently create a duplicate permission.
 *
 * `z.string().email()` is intentionally the whole validation. Anything stricter
 * rejects addresses that are legal and in use — plus-addressing, new TLDs,
 * internal corporate domains — and the only real proof that an address works is
 * that mail sent to it arrives.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email("That doesn't look like an email address")
  .max(254, "That email address is too long");

const grantableRole = z.enum(SHEET_GRANTABLE_ROLES);

const columnName = trimmedString(LIMITS.SHEET_COLUMN_NAME_MAX, "Column name");

const columnOptions = z
  .array(z.string().trim().max(LIMITS.SHEET_COLUMN_NAME_MAX))
  .max(LIMITS.SHEET_MAX_SELECT_OPTIONS)
  .optional();

const columnWidth = z.coerce.number().int().min(60).max(800).optional();

const columnInput = z.object({
  name: columnName,
  type: z.nativeEnum(SHEET_COLUMN_TYPES).optional(),
  width: columnWidth,
  options: columnOptions,
});

/* -------------------------------- Sheets --------------------------------- */

const createSheetSchema = z.object({
  /**
   * Optional, and defaulted rather than refused.
   *
   * Naming a thing before it exists is the wrong order — nobody knows what to
   * call an empty grid, so the dialog that insists on it is a speed bump before
   * the first row is typed. Every spreadsheet app resolves this the same way: it
   * creates "Untitled spreadsheet" and lets the title be fixed later, by which
   * point the sheet's contents make the name obvious. `.catch` rather than
   * `.default` so a title that is present but blank lands on the default too,
   * instead of failing the length check.
   */
  title: trimmedString(LIMITS.SHEET_TITLE_MAX, "Title")
    .optional()
    .catch(undefined)
    .transform((value) => value || DEFAULT_SHEET_TITLE),
  description: z.string().trim().max(LIMITS.SHEET_DESC_MAX).optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  /** Present only on "duplicate this layout"; a new sheet gets the defaults. */
  columns: z.array(columnInput).max(LIMITS.SHEET_MAX_COLUMNS).optional(),
  /**
   * Opening rows, as **arrays of values positional to `columns`** rather than
   * the usual `{ cells: { <columnKey>: value } }`.
   *
   * Column keys are generated server-side, so a client building a sheet from a
   * template cannot name them: it would have to create the sheet, read the keys
   * back, and post the rows in a second request — which lands the data *after*
   * the blank rows a new sheet opens with, leaving the table starting at row 31.
   * Positional values sidestep that entirely, because the same request carries
   * the columns they line up with.
   *
   * Used by Ria's blueprint card (docs/10-AI-ASSISTANT.md); ordinary creation
   * sends none.
   */
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .max(LIMITS.SHEET_MAX_BULK_ROWS)
    .optional(),
});

const updateSheetSchema = z
  .object({
    title: trimmedString(LIMITS.SHEET_TITLE_MAX, "Title").optional(),
    description: z.string().trim().max(LIMITS.SHEET_DESC_MAX).optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    visibility: z.nativeEnum(SHEET_VISIBILITY).optional(),
    /**
     * What "anyone with the link" may do. Only EDITOR and VIEWER: making the
     * whole internet an owner is not a setting anyone wants, and leaving OWNER
     * out of the enum means no request can ask for it — a guard the service does
     * not then have to repeat.
     */
    publicRole: z.enum([SHEET_ROLES.VIEWER, SHEET_ROLES.EDITOR]).optional(),
    /** Panes pinned while the rest scrolls. A view setting, editor-writable. */
    frozenRows: z.coerce.number().int().min(0).max(LIMITS.SHEET_MAX_FROZEN).optional(),
    frozenCols: z.coerce.number().int().min(0).max(LIMITS.SHEET_MAX_FROZEN).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  });

const protectRangeSchema = z.object({
  label: z.string().trim().max(80).optional(),
  columnKeys: z.array(z.string().trim().max(32)).min(1, "Select at least one column"),
  /** Omitted when `allRows` is set — the whole column is protected instead. */
  rowIds: z.array(objectId).max(LIMITS.SHEET_MAX_ROWS).optional(),
  allRows: z.boolean().optional(),
  /** Editors allowed through anyway. The owner is implicit and never listed. */
  allowedUserIds: z.array(objectId).max(LIMITS.SHEET_MAX_GRANTS).optional(),
});

const sortRowsSchema = z.object({
  columnKey: z.string().trim().min(1).max(32),
  direction: z.enum(["asc", "desc"]).optional().default("asc"),
});

/* -------------------------------- Columns -------------------------------- */

const addColumnSchema = columnInput.extend({
  /** Insert to the right of this column; appended when absent. */
  afterKey: z.string().trim().max(32).optional(),
  /**
   * Insert to the *left* of this column. Needed because `afterKey` cannot
   * express the left edge: there is no column before the first one to name, and
   * an absent `afterKey` means "append" rather than "prepend". Takes precedence
   * when both are sent.
   */
  beforeKey: z.string().trim().max(32).optional(),
});

const updateColumnSchema = z
  .object({
    name: columnName.optional(),
    type: z.nativeEnum(SHEET_COLUMN_TYPES).optional(),
    width: columnWidth,
    options: columnOptions,
    /** New index in the column order — drag-and-drop of a header. */
    position: z.coerce.number().int().min(0).max(LIMITS.SHEET_MAX_COLUMNS).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "Nothing to update" });

/* ---------------------------------- Rows --------------------------------- */

/**
 * A row's cells: `{ "<columnKey>": "<value>" }`.
 *
 * `z.record` rather than a declared object, because the keys are the sheet's own
 * column keys and are only knowable at runtime. Unknown keys and over-long values
 * are dropped by `sheetService.sanitiseCells` against the sheet's live columns —
 * which is the only place that knows what they are.
 *
 * Values are coerced from numbers and booleans as well as strings: a client
 * pasting a spreadsheet column of amounts naturally sends JSON numbers, and
 * refusing them would push a `String()` call into every caller.
 */
const cells = z.record(
  z.string().max(32),
  z.union([z.string(), z.number(), z.boolean(), z.null()]).transform((value) =>
    value === null ? "" : String(value)
  )
);

const rowInput = z.object({ cells: cells.optional().default({}) });

const createRowsSchema = z.object({
  rows: z.array(rowInput).min(1, "Nothing to add").max(LIMITS.SHEET_MAX_BULK_ROWS),
  /** Insert above this row; appended to the end when absent. */
  beforeRowId: objectId.optional(),
});

/**
 * Per-cell styling. Shape only — the *values* are whitelisted in
 * `sheetService.sanitiseFormats`, which is where it matters, because these end
 * up as CSS in other people's browsers.
 *
 * **Every field the grid can set must be listed here.** Zod strips keys an
 * object schema does not mention, so a field added to `sanitiseFormats` and
 * forgotten here is removed from the request before the service ever sees it —
 * silently, with a 200 and a response that simply lacks it. That is how number
 * formats, fonts, vertical alignment and borders all shipped inert: the
 * service-level tests call `updateRow` directly and never cross this boundary,
 * so they passed while the actual API dropped the value on the floor.
 *
 * The round-trip assertion in `scripts/check-sheets.js` now goes through this
 * schema for exactly that reason.
 */
const cellFormat = z.object({
  b: z.boolean().optional(),
  i: z.boolean().optional(),
  u: z.boolean().optional(),
  s: z.boolean().optional(),
  wrap: z.boolean().optional(),
  fg: z.string().max(9).optional(),
  bg: z.string().max(9).optional(),
  align: z.nativeEnum(SHEET_ALIGNMENTS).optional(),
  valign: z.nativeEnum(SHEET_VALIGN).optional(),
  /** Number format and its decimal places (§15b). */
  nf: z.nativeEnum(SHEET_NUMBER_FORMATS).optional(),
  dp: z.coerce.number().int().min(0).max(LIMITS.SHEET_DECIMALS_MAX).optional(),
  /** Font family name; the service checks it against SHEET_FONTS. */
  font: z.string().max(32).optional(),
  /** Border edges as a subset of `trbl`, and their colour. */
  bd: z.string().max(4).optional(),
  bdc: z.string().max(9).optional(),
  size: z.coerce
    .number()
    .int()
    .min(LIMITS.SHEET_FONT_SIZE_MIN)
    .max(LIMITS.SHEET_FONT_SIZE_MAX)
    .optional(),
});

const formats = z.record(z.string().max(32), cellFormat);

const updateRowSchema = z.object({
  cells: cells.optional().default({}),
  /** Sent alongside values or on its own — painting a cell is not a data edit. */
  formats: formats.optional().default({}),
  /**
   * Required, not optional. An update that does not state the version it read
   * cannot be checked for a concurrent edit, and a sheet is the one place in this
   * app where two people editing at once is the expected case rather than the
   * unlucky one (models/sheetRow.js).
   */
  version: z.coerce.number().int().min(0),
});

const deleteRowsSchema = z.object({
  rowIds: z.array(objectId).min(1, "Nothing to delete").max(LIMITS.SHEET_MAX_BULK_ROWS),
});

const moveRowSchema = z.object({
  /** Absent means "to the end" — the same convention as createRows. */
  beforeRowId: objectId.nullable().optional(),
});

const listRowsQuery = z.object({
  cursor: z.string().max(64).optional(),
  /**
   * Larger than the app's usual page size (LIMITS.MAX_PAGE_SIZE, 50). A grid is
   * scrolled, not paged: 50 rows is under a screen on a desktop monitor and would
   * make the first scroll gesture hit a loading state.
   */
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});

/* -------------------------------- Sharing -------------------------------- */

const shareSchema = z.object({
  email,
  role: grantableRole.optional().default(SHEET_ROLES.VIEWER),
  /** A line in the invitation email. Optional, and often the reason it gets read. */
  message: z.string().trim().max(500).optional(),
});

const updateGrantSchema = z.object({ role: grantableRole });

const requestAccessSchema = z.object({
  message: z.string().trim().max(500).optional(),
  role: grantableRole.optional().default(SHEET_ROLES.VIEWER),
});

const decideRequestSchema = z.object({
  /** The owner may grant something other than what was asked for. */
  role: grantableRole.optional(),
});

/* -------------------------------- Params --------------------------------- */

const shareCodeParams = z.object({ shareCode: z.string().trim().min(8).max(32) });

const rowParams = shareCodeParams.extend({ rowId: objectId });
const columnParams = shareCodeParams.extend({ columnKey: z.string().trim().min(1).max(32) });
const grantParams = shareCodeParams.extend({ grantId: objectId });
const rangeParams = shareCodeParams.extend({ rangeId: z.string().trim().min(1).max(32) });
const requestParams = shareCodeParams.extend({ requestId: objectId });

module.exports = {
  protectRangeSchema,
  sortRowsSchema,
  rangeParams,
  createSheetSchema,
  updateSheetSchema,
  addColumnSchema,
  updateColumnSchema,
  createRowsSchema,
  updateRowSchema,
  deleteRowsSchema,
  moveRowSchema,
  listRowsQuery,
  shareSchema,
  updateGrantSchema,
  requestAccessSchema,
  decideRequestSchema,
  shareCodeParams,
  rowParams,
  columnParams,
  grantParams,
  requestParams,
};
