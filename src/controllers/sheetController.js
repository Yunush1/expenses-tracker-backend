const asyncHandler = require("../middlewares/asyncHandler");
const sheetService = require("../services/sheetService");
const accessService = require("../services/sheetAccessService");
const { ok, created, accepted } = require("../utils/apiResponse");
const {
  toSheetDTO,
  toRowDTO,
  toGrantDTO,
  toRequestDTO,
} = require("../serializers/sheetSerializer");

/**
 * Expense sheets (docs/20-EXPENSE-SHEETS.md §7).
 *
 * Thin, like every controller here. Note the one thing every handler has in
 * common: it passes `req.user` straight through and never a role, a visibility or
 * a grant. Authorisation is resolved once, inside the service, from the verified
 * token — so there is no path where a client-supplied field decides what it is
 * allowed to see.
 *
 * `req.user` is null on the read routes, which are mounted behind `optionalAuth`
 * so a public sheet opens signed out. Every write route sits behind `requireAuth`
 * and can rely on it.
 */

/**
 * The caller's own socket, so the live broadcast can skip them.
 *
 * The client that made this edit has already applied it optimistically
 * (`useRowSaver`), and echoing it back would overwrite that local echo with a
 * value that is identical *unless* they have typed again since — in which case it
 * silently reverts their newer keystrokes.
 *
 * Purely an optimisation hint, and safe to be wrong about: it can only ever cause
 * one socket to *miss* a notification it did not need. It grants nothing, is
 * never an identity, and is never consulted by an authorisation decision — which
 * is why taking it from a client-supplied header is fine here and would not be
 * for anything else.
 */
const socketOf = (req) => req.get("X-Socket-Id") || null;

exports.listSheets = asyncHandler(async (req, res) => {
  const entries = await sheetService.listSheets(req.user);

  return ok(
    res,
    entries.map(({ sheet, role, pendingRequestCount, preview }) =>
      toSheetDTO(sheet, { role, pendingRequestCount, preview })
    )
  );
});

exports.createSheet = asyncHandler(async (req, res) => {
  const sheet = await sheetService.createSheet(req.user, req.body);
  return created(res, toSheetDTO(sheet, { role: "OWNER" }), "Sheet created");
});

exports.getSheet = asyncHandler(async (req, res) => {
  const { sheet, role, source } = await sheetService.getSheet(req.params.shareCode, req.user);
  return ok(res, toSheetDTO(sheet, { role, source }));
});

exports.updateSheet = asyncHandler(async (req, res) => {
  const sheet = await sheetService.updateSheet(req.params.shareCode, req.user, req.body, socketOf(req));
  // Re-resolved rather than assumed: an owner changing visibility must get back a
  // DTO whose `role` still says OWNER, and a resolved role is the only honest
  // source for that.
  const { role, source } = await accessService.resolveAccess(sheet, req.user);
  return ok(res, toSheetDTO(sheet, { role, source }), "Sheet updated");
});

exports.deleteSheet = asyncHandler(async (req, res) =>
  ok(res, await sheetService.deleteSheet(req.params.shareCode, req.user, socketOf(req)), "Sheet deleted")
);

/* -------------------------------- Columns -------------------------------- */

exports.addColumn = asyncHandler(async (req, res) => {
  const { sheet, column } = await sheetService.addColumn(req.params.shareCode, req.user, req.body, socketOf(req));
  const { role, source } = await accessService.resolveAccess(sheet, req.user);
  return created(res, { sheet: toSheetDTO(sheet, { role, source }), column }, "Column added");
});

exports.updateColumn = asyncHandler(async (req, res) => {
  const sheet = await sheetService.updateColumn(
    req.params.shareCode,
    req.user,
    req.params.columnKey,
    req.body,
    socketOf(req)
  );
  const { role, source } = await accessService.resolveAccess(sheet, req.user);
  return ok(res, toSheetDTO(sheet, { role, source }), "Column updated");
});

exports.deleteColumn = asyncHandler(async (req, res) => {
  const sheet = await sheetService.deleteColumn(
    req.params.shareCode,
    req.user,
    req.params.columnKey,
    socketOf(req)
  );
  const { role, source } = await accessService.resolveAccess(sheet, req.user);
  return ok(res, toSheetDTO(sheet, { role, source }), "Column deleted");
});

/* ---------------------------------- Rows --------------------------------- */

/**
 * The grid read. Returns the sheet alongside the rows so a cold open is one call
 * rather than two — the columns are needed to render the rows at all, and a
 * second round trip would show a header with no body for its duration.
 */
exports.listRows = asyncHandler(async (req, res) => {
  const { sheet, role, source, rows, nextCursor } = await sheetService.listRows(
    req.params.shareCode,
    req.user,
    req.validatedQuery
  );

  return ok(res, {
    sheet: toSheetDTO(sheet, { role, source }),
    rows: rows.map(toRowDTO),
    nextCursor,
  });
});

exports.createRows = asyncHandler(async (req, res) => {
  const { rows } = await sheetService.createRows(req.params.shareCode, req.user, req.body, socketOf(req));
  return created(res, { rows: rows.map(toRowDTO) }, `${rows.length} row${rows.length === 1 ? "" : "s"} added`);
});

exports.updateRow = asyncHandler(async (req, res) => {
  const row = await sheetService.updateRow(
    req.params.shareCode,
    req.user,
    req.params.rowId,
    req.body,
    socketOf(req)
  );
  return ok(res, toRowDTO(row), "Saved");
});

exports.deleteRows = asyncHandler(async (req, res) =>
  ok(res, await sheetService.deleteRows(req.params.shareCode, req.user, req.body.rowIds, socketOf(req)), "Deleted")
);

exports.moveRow = asyncHandler(async (req, res) => {
  const row = await sheetService.moveRow(
    req.params.shareCode,
    req.user,
    req.params.rowId,
    req.body,
    socketOf(req)
  );
  return ok(res, toRowDTO(row), "Row moved");
});

/**
 * Reorder every row by a column. An edit, not a view — see sheetService.sortRows
 * for why sorting is shared state and filtering is not.
 */
exports.sortRows = asyncHandler(async (req, res) => {
  const { rows } = await sheetService.sortRows(
    req.params.shareCode,
    req.user,
    req.body,
    socketOf(req)
  );
  return ok(res, { rows: rows.map(toRowDTO) }, "Sorted");
});

/* ------------------------------- Protection ------------------------------- */

exports.protectRange = asyncHandler(async (req, res) => {
  const sheet = await sheetService.protectRange(
    req.params.shareCode,
    req.user,
    req.body,
    socketOf(req)
  );
  const { role, source } = await accessService.resolveAccess(sheet, req.user);
  return created(res, toSheetDTO(sheet, { role, source }), "Range locked");
});

exports.unprotectRange = asyncHandler(async (req, res) => {
  const sheet = await sheetService.unprotectRange(
    req.params.shareCode,
    req.user,
    req.params.rangeId,
    socketOf(req)
  );
  const { role, source } = await accessService.resolveAccess(sheet, req.user);
  return ok(res, toSheetDTO(sheet, { role, source }), "Range unlocked");
});

/* -------------------------------- Sharing -------------------------------- */

exports.listAccess = asyncHandler(async (req, res) => {
  const { grants, requests, owner, emailConfigured } = await accessService.listAccess(
    req.params.shareCode,
    req.user
  );

  return ok(res, {
    owner: { name: owner?.displayName || "", email: owner?.email || "", photoURL: owner?.photoURL || "" },
    grants: grants.map(toGrantDTO),
    requests: requests.map(toRequestDTO),
    /**
     * Whether this deployment can send email at all. The share dialog uses it to
     * choose its wording up front — "we'll email them" against "copy this link
     * and send it yourself" — rather than promising a message and then reporting
     * it never went (config/mail.js).
     */
    emailConfigured,
  });
});

exports.share = asyncHandler(async (req, res) => {
  const { grant, notified, emailConfigured } = await accessService.share(
    req.params.shareCode,
    req.user,
    req.body
  );

  return created(
    res,
    { grant: toGrantDTO(grant), notified, emailConfigured },
    notified
      ? `Invitation sent to ${grant.email}`
      : `${grant.email} now has access — but we couldn't email them. Send them the link.`
  );
});

exports.updateGrant = asyncHandler(async (req, res) => {
  const grant = await accessService.updateGrantRole(
    req.params.shareCode,
    req.user,
    req.params.grantId,
    req.body.role
  );
  return ok(res, toGrantDTO(grant), "Access updated");
});

exports.revokeGrant = asyncHandler(async (req, res) => {
  const { removedEmail } = await accessService.revokeGrant(
    req.params.shareCode,
    req.user,
    req.params.grantId
  );
  return ok(res, { removedEmail }, `${removedEmail} no longer has access`);
});

/* ---------------------------- Access requests ---------------------------- */

/**
 * 202, not 201: the caller asked for access and does not have it. A 201 with a
 * request-shaped body is exactly the thing a client reads as success — the same
 * argument apiResponse.accepted was added for, on the group join flow.
 */
exports.requestAccess = asyncHandler(async (req, res) => {
  const { request, alreadyPending, notified } = await accessService.requestAccess(
    req.params.shareCode,
    req.user,
    req.body
  );

  return accepted(
    res,
    { request: toRequestDTO(request), notified },
    alreadyPending
      ? "You've already asked for access to this sheet."
      : notified
        ? "Request sent — the owner has been emailed."
        : "Request sent. The owner will see it next time they open the sheet."
  );
});

exports.approveRequest = asyncHandler(async (req, res) => {
  const { request, grantedRole } = await accessService.decideRequest(
    req.params.shareCode,
    req.user,
    req.params.requestId,
    { approve: true, role: req.body.role }
  );

  return ok(
    res,
    { request: toRequestDTO(request), role: grantedRole },
    `${request.email} can now ${grantedRole === "EDITOR" ? "edit" : "view"} this sheet`
  );
});

exports.declineRequest = asyncHandler(async (req, res) => {
  const { request } = await accessService.decideRequest(
    req.params.shareCode,
    req.user,
    req.params.requestId,
    { approve: false }
  );

  return ok(res, { request: toRequestDTO(request) }, "Request declined");
});

exports.cancelRequest = asyncHandler(async (req, res) =>
  ok(
    res,
    { request: toRequestDTO(await accessService.cancelRequest(req.params.shareCode, req.user)) },
    "Request withdrawn"
  )
);
