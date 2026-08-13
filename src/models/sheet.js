const mongoose = require("mongoose");
const crypto = require("crypto");

const {
  LIMITS,
  SHEET_VISIBILITY,
  SHEET_ROLES,
  SHEET_COLUMN_TYPES,
  DEFAULT_CURRENCY,
} = require("../constants");

/**
 * A free-form expense grid (docs/20-EXPENSE-SHEETS.md).
 *
 * ## Why this is not a group, and not an expense
 *
 * A group divides money between people and guarantees `Σ net balances = 0`. It
 * can only do that because every rupee has a payer and participants who are all
 * members, and because amounts are integer minor units that never round
 * (docs/05-ALGORITHMS.md §1). A sheet gives all of that up on purpose: cells are
 * strings, columns mean whatever their author says they mean, and nothing here
 * feeds a balance, a settlement or the ledger. It is a register, not a ledger.
 *
 * That trade is what buys the thing a company with fifty expenses a day actually
 * needs — type a row, tab across, paste a block from Excel — and it is why sheets
 * live in their own collection with no path back into group arithmetic. A number
 * that has been through a text cell must never be allowed to decide what someone
 * owes.
 *
 * ## Why the owner is an account
 *
 * Sharing here is by **email address**, which only means something if the person
 * opening the sheet has proved which address is theirs. Groups deliberately have
 * no login (docs/09-AUTH.md §1) and resolve identity from a device id, and a
 * device cannot prove an email. So a sheet is owned by a `User`, like the
 * personal ledger — the second and last account-gated resource in this API.
 */

const columnSchema = new mongoose.Schema(
  {
    /**
     * A generated, immutable handle — **not** the display name.
     *
     * Rows key their cells by this, so renaming "Amount" to "Amount (incl. GST)"
     * is a one-field write on this document and touches no rows at all. Had the
     * name been the key, every rename would have to rewrite every row in the
     * sheet, non-atomically, and a failure halfway would strand cells under a
     * column that no longer exists.
     */
    key: {
      type: String,
      required: true,
      // 8 hex chars — collisions only have to be avoided within one sheet's
      // handful of columns, so this is generous rather than tight.
      default: () => `c${crypto.randomBytes(4).toString("hex")}`,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.SHEET_COLUMN_NAME_MAX,
    },
    /** Presentation only — see SHEET_COLUMN_TYPES for why it is not enforced. */
    type: {
      type: String,
      enum: Object.values(SHEET_COLUMN_TYPES),
      default: SHEET_COLUMN_TYPES.TEXT,
    },
    /** Pixels, as dragged by the user. Clamped in the service, not here. */
    width: {
      type: Number,
      default: 160,
      min: 60,
      max: 800,
    },
    /**
     * Suggestions offered by a SELECT column's editor. Suggestions, not a
     * constraint: a cell may hold a value that is not in this list, because the
     * grid is free-form and refusing a typed value mid-flow to enforce a list
     * the user themselves wrote is the kind of help nobody asked for.
     */
    options: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

/**
 * A rectangle of cells only the owner (and anyone they name) may change
 * (docs/20-EXPENSE-SHEETS.md §12).
 *
 * ## Why cells are named by id, not by coordinates
 *
 * The obvious shape is `{ top, bottom, left, right }` — and it is wrong here,
 * because rows move. Insert a row above a protected block and every index below
 * it shifts by one: the protection silently slides off the cells it was meant to
 * cover and onto cells nobody protected. Nothing errors, and the failure is
 * invisible until somebody edits a number they should not have been able to.
 *
 * Naming the actual `rowIds` and `columnKeys` makes the protection stick to the
 * data rather than to a position. The trade, stated: a row inserted *into* a
 * protected block is not itself protected, because it did not exist when the
 * decision was made. That is the safer default — a new row is unprotected until
 * somebody says otherwise, rather than silently acquiring a restriction its
 * author never chose.
 */
const protectedRangeSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      default: () => `p${crypto.randomBytes(4).toString("hex")}`,
    },
    /** Shown when a write is refused, so the message can say *which* range. */
    label: { type: String, trim: true, maxlength: 80, default: "" },
    columnKeys: { type: [String], default: [] },
    /** Empty together with `allRows` false means the whole column is protected. */
    rowIds: { type: [String], default: [] },
    /**
     * Protect these columns entirely, including rows added later. The one case
     * where position-independence is genuinely wanted: "finance owns the Amount
     * column" is a statement about the column, not about today's rows.
     */
    allRows: { type: Boolean, default: false },
    /**
     * Editors who may write here anyway. The owner is always allowed and is
     * never listed — deriving it avoids a range that outlives its own owner
     * entry after an ownership change.
     */
    allowedUserIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false }
);

const sheetSchema = new mongoose.Schema(
  {
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.SHEET_TITLE_MAX,
    },
    description: {
      type: String,
      trim: true,
      maxlength: LIMITS.SHEET_DESC_MAX,
      default: "",
    },
    /**
     * The handle in the URL — `/sheet/<shareCode>`.
     *
     * 96 bits from a CSPRNG, exactly like a group's invite code, because in
     * `PUBLIC` mode possession of it *is* the credential and it must not be
     * guessable. In `PRIVATE` mode it is only an address: holding it gets an
     * unauthorised caller the request-access screen and nothing else, which is
     * the property that makes offering that screen safe.
     *
     * Note what is deliberately absent: a short, typed-in code. A group has one
     * because people read it aloud across a table; a sheet is shared by email to
     * a named address, and a weak second credential would only widen the
     * surface — the exact hole docs/13-JOIN-APPROVAL.md was written to close.
     */
    shareCode: {
      type: String,
      required: true,
      unique: true,
    },
    columns: {
      type: [columnSchema],
      default: [],
      validate: {
        validator: (columns) => columns.length <= LIMITS.SHEET_MAX_COLUMNS,
        message: `A sheet cannot have more than ${LIMITS.SHEET_MAX_COLUMNS} columns`,
      },
    },
    visibility: {
      type: String,
      enum: Object.values(SHEET_VISIBILITY),
      default: SHEET_VISIBILITY.PRIVATE,
    },
    /**
     * What "anyone with the link" may do, once `visibility` is PUBLIC. Ignored
     * entirely while PRIVATE.
     *
     * Stored separately from `visibility` rather than folded into it as a third
     * enum value (`PUBLIC_EDIT`), because they answer different questions — *who*
     * can open this, and *what may they do* — and the UI presents them as two
     * controls, as every product with this feature does. Folding them makes
     * "make it public" and "let them edit" the same irreversible click.
     */
    publicRole: {
      type: String,
      enum: [SHEET_ROLES.VIEWER, SHEET_ROLES.EDITOR],
      default: SHEET_ROLES.VIEWER,
    },
    /**
     * Display only — how a NUMBER column's footer total is formatted. Nothing
     * here converts, rounds or validates a cell; see the header.
     */
    currency: {
      type: String,
      default: DEFAULT_CURRENCY,
      uppercase: true,
      trim: true,
    },
    /**
     * Rows and columns pinned in place while the rest scrolls.
     *
     * Purely a view setting, and stored on the sheet rather than per person on
     * purpose: a frozen header row is a property of how the sheet is *built* —
     * whoever set it up knows which rows are headers — and everyone opening it
     * benefits from the same answer. Per-user view state would need a second
     * collection to hold a number that nobody would ever set differently.
     */
    frozenRows: { type: Number, default: 0, min: 0, max: LIMITS.SHEET_MAX_FROZEN },
    frozenCols: { type: Number, default: 0, min: 0, max: LIMITS.SHEET_MAX_FROZEN },

    /**
     * Ranges the owner has locked. Enforced in `sheetService.assertWritable` on
     * every cell write — the UI's padlock is a courtesy, this is the rule.
     */
    protectedRanges: {
      type: [protectedRangeSchema],
      default: [],
      validate: {
        validator: (ranges) => ranges.length <= LIMITS.SHEET_MAX_PROTECTED_RANGES,
        message: `A sheet cannot have more than ${LIMITS.SHEET_MAX_PROTECTED_RANGES} protected ranges`,
      },
    },

    /**
     * Denormalised for the sheet list, which would otherwise count rows across
     * every sheet on every render. Maintained with atomic `$inc`, and — as with
     * `Group.memberCount` — no correctness decision anywhere reads it.
     */
    rowCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * The largest `position` handed out so far, so appending a row is a single
     * `$inc` rather than a "find the last row" query on every keystroke-fast
     * append. See models/sheetRow.js for the ordering scheme.
     */
    positionCursor: {
      type: Number,
      default: 0,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
    /**
     * Soft delete. A sheet is the shared record of what a company spent, and
     * "someone deleted the expenses" must be recoverable by an operator rather
     * than final. Rows are left untouched and filtered by the sheet's state.
     */
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

/** The sheet list: one account's own sheets, most recently touched first. */
sheetSchema.index({ ownerUserId: 1, isDeleted: 1, lastActivityAt: -1, });

module.exports = mongoose.model("Sheet", sheetSchema);
