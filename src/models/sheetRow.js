const mongoose = require("mongoose");
const { LIMITS } = require("../constants");

/**
 * One row of a sheet (docs/20-EXPENSE-SHEETS.md §2).
 *
 * ## Why a row is a document and not an array element
 *
 * The obvious alternative is `rows: [...]` embedded on the Sheet. It is wrong
 * here for three reasons that compound: a 20 000-row sheet would exceed the 16MB
 * document ceiling; every cell edit would rewrite the entire sheet document,
 * which at one-keystroke-per-save granularity is the hot path; and two people
 * editing different rows would contend on the same document on every write,
 * turning a collaborative grid into a queue.
 *
 * ## Ordering: gaps, not indexes
 *
 * `position` is a sparse number rather than a dense 0..n index. Inserting a row
 * between two others is then the midpoint of its neighbours — one write — instead
 * of renumbering every row below it, which for an insert near the top of a large
 * sheet is thousands of writes to move one line.
 *
 * The known cost, stated rather than discovered later: repeatedly inserting at
 * the *same* spot halves the gap each time, and a double runs out of precision
 * after roughly fifty consecutive splits there. `SHEET_POSITION_STEP` (65 536)
 * makes that a distant hypothetical rather than a daily one, and
 * `sheetService.rebalance` restores the gaps when a split has nowhere left to go.
 * Appending — the overwhelmingly common case — never splits at all: it takes the
 * sheet's `positionCursor` and adds a step.
 */
const sheetRowSchema = new mongoose.Schema(
  {
    sheetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sheet",
      required: true,
      index: true,
    },
    position: {
      type: Number,
      required: true,
    },
    /**
     * `columnKey -> value`, every value a string.
     *
     * A `Map` rather than a plain object because Mongoose otherwise needs a
     * declared shape for every path, and the whole point here is that the shape
     * is the user's to decide at runtime. A Map also keeps keys that begin with
     * `$` or contain dots from being interpreted as operators or paths — and
     * while column keys are generated (`c1a2b3c4`) and never user-supplied, that
     * is one fewer thing depending on a fact somewhere else staying true.
     *
     * Cells for a deleted column are left behind rather than swept.
     * `sheetService.deleteColumn` removes the column from the sheet, so those
     * values become unreachable — which is exactly what makes an accidental
     * column delete recoverable by re-adding it with the same key. They are
     * filtered out on read, never returned.
     */
    cells: {
      type: Map,
      of: String,
      default: () => new Map(),
    },
    /**
     * `columnKey -> { b, i, u, s, fg, bg, align, wrap, size }` — how a cell looks.
     *
     * ## Why formatting is a separate map from `cells`
     *
     * Because the two change independently and at very different rates. Typing a
     * value must not rewrite its formatting, and painting a column yellow must
     * not touch a single value — so a shared structure would mean every cell edit
     * carrying formatting it did not change, and every format change carrying
     * values it did not change. Two people doing those two things to the same row
     * would then conflict over a version bump neither of them caused.
     *
     * ## Why the keys are one and two letters
     *
     * `b` rather than `bold`, `fg` rather than `textColour`. This map is stored on
     * every formatted cell of a sheet that may hold 20 000 rows, and BSON stores
     * the key string with every single one — so a 20 000-row column of bold cells
     * pays the difference 20 000 times. It is the one place in this codebase where
     * terseness beats readability, and it is confined to a shape that is written
     * and read in exactly two functions.
     *
     * Absent means "default": an unformatted cell stores nothing at all, which is
     * the overwhelmingly common case and costs zero bytes.
     */
    formats: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
    createdByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    /**
     * Who touched it last. The whole audit trail a sheet keeps, deliberately:
     * per-cell revision history is what a real spreadsheet offers and is a
     * feature in its own right, not a field. This much answers "who changed
     * this?" for the case that actually comes up.
     */
    updatedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /**
     * Optimistic concurrency, same contract as an expense: an update states the
     * version it read and is rejected if that is no longer current.
     *
     * It matters more here than anywhere else in the app, because a sheet is the
     * one place two people are expected to be typing at the same time. Without
     * it, the second save silently wins the whole row — including the columns the
     * second person never touched.
     */
    version: {
      type: Number,
      default: 0,
    },
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

/** The grid read: one sheet's live rows in display order. Covers the sort. */
sheetRowSchema.index({ sheetId: 1, isDeleted: 1, position: 1 });

sheetRowSchema.path("cells").validate(function cellsWithinLimits(cells) {
  if (!cells) return true;
  // Defence in depth behind the validator: a single oversized cell would
  // otherwise be capped nowhere, and a Map has no `maxlength`.
  for (const value of cells.values()) {
    if (typeof value === "string" && value.length > LIMITS.SHEET_CELL_MAX) return false;
  }
  return true;
}, `A cell must be ${LIMITS.SHEET_CELL_MAX} characters or fewer`);

module.exports = mongoose.model("SheetRow", sheetRowSchema);
