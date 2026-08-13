const express = require("express");

const sheetController = require("../controllers/sheetController");
const requireAuth = require("../middlewares/requireAuth");
const optionalAuth = require("../middlewares/optionalAuth");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const {
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
  protectRangeSchema,
  sortRowsSchema,
  rangeParams,
} = require("../validators/sheetValidators");

const router = express.Router();

/**
 * Expense sheets (docs/20-EXPENSE-SHEETS.md).
 *
 * ## Why this router mixes `optionalAuth` and `requireAuth`
 *
 * The ledger router applies `requireAuth` once at the mount, and says so loudly:
 * a ledger route that forgot it would expose one person's private records. That
 * cannot be done here, because a **public** sheet must open for someone who is
 * not signed in — that is what "anyone with the link" means, and it is half the
 * feature.
 *
 * So the split is by verb, and it is the rule to check when adding a route:
 *
 * - **Reads** are `optionalAuth`. Identity is attached when there is one, and its
 *   absence is not an error. `sheetAccessService.requireAccess` then refuses the
 *   anonymous caller on anything not public — the authorisation is in the
 *   service, and it is the same code path whether or not a token was sent.
 * - **Writes** are `requireAuth`. Every one of them changes something somebody
 *   owns, and a public-editor still has to be *somebody*: rows record who wrote
 *   them, and "edited by nobody" is not a thing a shared register can afford.
 *   The cost is stated plainly — anonymous editing of a public sheet is not
 *   offered, deliberately.
 *
 * The load-bearing consequence: a missing `optionalAuth` on a read fails safe
 * (the caller looks anonymous and gets less), while a missing `requireAuth` on a
 * write fails open. That asymmetry is why writes name it individually rather than
 * relying on ordering.
 */

/* --------------------------------- Sheets -------------------------------- */

/** "My sheets", plus the ones shared with me. Nothing to see signed out. */
router.get("/", requireAuth, sheetController.listSheets);

router.post("/", requireAuth, writeLimiter, validate(createSheetSchema), sheetController.createSheet);

/* ---------------------------------- Rows --------------------------------- */

/**
 * Declared before "/:shareCode" so the literal path segments below are not
 * swallowed by the parameter — the same ordering hazard the ledger router calls
 * out for "/contacts".
 */
router.get(
  "/:shareCode/rows",
  optionalAuth,
  validate(shareCodeParams, "params"),
  validate(listRowsQuery, "query"),
  sheetController.listRows
);

/**
 * Add rows — one from the "+" button, up to `SHEET_MAX_BULK_ROWS` from a paste.
 * One endpoint for both, because they are the same operation with a different
 * row count (sheetService.createRows).
 */
router.post(
  "/:shareCode/rows",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  validate(createRowsSchema),
  sheetController.createRows
);

/**
 * Deliberately not behind `writeLimiter`.
 *
 * This is the per-cell save, and it fires as fast as somebody types across a
 * row — which is the entire point of the feature. The shared write limiter is
 * 120 requests per 15 minutes, and a person entering forty expenses would hit it
 * inside a minute and be locked out of their own spreadsheet mid-sentence.
 *
 * What still bounds it: `globalLimiter` (300 per 15 minutes, applied in app.js to
 * everything), `requireAuth`, and the fact that a write here can only ever touch
 * a row on a sheet the caller already has edit access to. There is no
 * amplification and nothing to enumerate — the cost of abuse falls on the
 * abuser's own sheet.
 */
router.patch(
  "/:shareCode/rows/:rowId",
  requireAuth,
  validate(rowParams, "params"),
  validate(updateRowSchema),
  sheetController.updateRow
);

router.post(
  "/:shareCode/rows/:rowId/move",
  requireAuth,
  writeLimiter,
  validate(rowParams, "params"),
  validate(moveRowSchema),
  sheetController.moveRow
);

/**
 * DELETE with a body: the grid deletes a multi-row selection in one call, and
 * `rowIds` in a query string would hit URL length limits at a few hundred ids.
 * Express 5 parses a body on DELETE without complaint.
 */
router.delete(
  "/:shareCode/rows",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  validate(deleteRowsSchema),
  sheetController.deleteRows
);

/**
 * Sort — behind `writeLimiter`, unlike the per-cell save. It rewrites every row's
 * position in the sheet, so it is the single most expensive write here and the
 * one worth metering.
 */
router.post(
  "/:shareCode/rows/sort",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  validate(sortRowsSchema),
  sheetController.sortRows
);

/* ------------------------------- Protection ------------------------------- */

/** Owner only, enforced in the service — the padlock the UI draws is decoration. */
router.post(
  "/:shareCode/protected-ranges",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  validate(protectRangeSchema),
  sheetController.protectRange
);

router.delete(
  "/:shareCode/protected-ranges/:rangeId",
  requireAuth,
  writeLimiter,
  validate(rangeParams, "params"),
  sheetController.unprotectRange
);

/* -------------------------------- Columns -------------------------------- */

router.post(
  "/:shareCode/columns",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  validate(addColumnSchema),
  sheetController.addColumn
);

router.patch(
  "/:shareCode/columns/:columnKey",
  requireAuth,
  writeLimiter,
  validate(columnParams, "params"),
  validate(updateColumnSchema),
  sheetController.updateColumn
);

router.delete(
  "/:shareCode/columns/:columnKey",
  requireAuth,
  writeLimiter,
  validate(columnParams, "params"),
  sheetController.deleteColumn
);

/* -------------------------------- Sharing -------------------------------- */

/** The share dialog's contents: who has access, and who is asking. Owner only. */
router.get(
  "/:shareCode/access",
  requireAuth,
  validate(shareCodeParams, "params"),
  sheetController.listAccess
);

router.post(
  "/:shareCode/access/invites",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  validate(shareSchema),
  sheetController.share
);

router.patch(
  "/:shareCode/access/grants/:grantId",
  requireAuth,
  writeLimiter,
  validate(grantParams, "params"),
  validate(updateGrantSchema),
  sheetController.updateGrant
);

router.delete(
  "/:shareCode/access/grants/:grantId",
  requireAuth,
  writeLimiter,
  validate(grantParams, "params"),
  sheetController.revokeGrant
);

/* ---------------------------- Access requests ---------------------------- */

/**
 * "Let me in." Behind `writeLimiter` because it is the one write reachable by
 * someone with **no** access to the resource — so it is the one worth metering
 * against a caller filling an owner's inbox.
 */
router.post(
  "/:shareCode/access/requests",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  validate(requestAccessSchema),
  sheetController.requestAccess
);

/** Withdraw your own. Resolved from the token, so there is no id to tamper with. */
router.delete(
  "/:shareCode/access/requests",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  sheetController.cancelRequest
);

router.post(
  "/:shareCode/access/requests/:requestId/approve",
  requireAuth,
  writeLimiter,
  validate(requestParams, "params"),
  validate(decideRequestSchema),
  sheetController.approveRequest
);

router.post(
  "/:shareCode/access/requests/:requestId/decline",
  requireAuth,
  writeLimiter,
  validate(requestParams, "params"),
  sheetController.declineRequest
);

/* ------------------------------ One sheet -------------------------------- */

/**
 * Last, so every literal segment above wins over the parameter.
 *
 * `optionalAuth` on the GET is what lets a public sheet open with no account —
 * see the header. The two writes name `requireAuth` for themselves.
 */
router.get(
  "/:shareCode",
  optionalAuth,
  validate(shareCodeParams, "params"),
  sheetController.getSheet
);

router.patch(
  "/:shareCode",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  validate(updateSheetSchema),
  sheetController.updateSheet
);

router.delete(
  "/:shareCode",
  requireAuth,
  writeLimiter,
  validate(shareCodeParams, "params"),
  sheetController.deleteSheet
);

module.exports = router;
