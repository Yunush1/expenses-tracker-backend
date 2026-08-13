const { SHEET_ROLES } = require("../constants");

/**
 * Sheet DTOs (docs/20-EXPENSE-SHEETS.md §7).
 *
 * Its own file rather than an addition to serializers/index.js: nothing here
 * shares a helper with the group serializers, and in particular nothing goes
 * through `toMajor` — a sheet stores strings, not minor units, and reaching for
 * the money helpers is exactly the mistake this separation makes hard to make.
 */

const id = (value) => (value ? String(value) : null);

const toColumnDTO = (column) => ({
  key: column.key,
  name: column.name,
  type: column.type,
  width: column.width,
  options: column.options || [],
});

/**
 * `role` is stamped onto every sheet the client receives, so the UI never has to
 * infer what the caller may do by re-deriving the rules. The server decided; the
 * client renders that decision.
 */
const toSheetDTO = (sheet, { role = null, source = null, pendingRequestCount = 0 } = {}) => ({
  id: id(sheet._id),
  title: sheet.title,
  description: sheet.description || "",
  shareCode: sheet.shareCode,
  columns: (sheet.columns || []).map(toColumnDTO),
  visibility: sheet.visibility,
  publicRole: sheet.publicRole,
  currency: sheet.currency,
  frozenRows: sheet.frozenRows || 0,
  frozenCols: sheet.frozenCols || 0,
  /**
   * Which cells are locked — **not** who may edit them.
   *
   * `allowedUserIds` is deliberately dropped. Every collaborator needs to know a
   * cell is protected, so the grid can show a padlock and refuse to open an
   * editor there; nobody needs the list of people who are exempt, and shipping it
   * would hand every viewer a roster of account ids. The client renders the
   * restriction; the server decides who it applies to (sheetService.assertWritable).
   */
  protectedRanges: (sheet.protectedRanges || []).map(toProtectedRangeDTO),
  rowCount: sheet.rowCount || 0,
  role,
  accessSource: source,
  /** Convenience flags, so a template is never the place permission logic lives. */
  canEdit: role === SHEET_ROLES.OWNER || role === SHEET_ROLES.EDITOR,
  isOwner: role === SHEET_ROLES.OWNER,
  /** Only ever non-zero for an owner — nobody else is shown that a queue exists. */
  pendingRequestCount,
  createdAt: sheet.createdAt,
  lastActivityAt: sheet.lastActivityAt,
});

const toProtectedRangeDTO = (range) => ({
  id: range.id,
  label: range.label || "",
  columnKeys: range.columnKeys || [],
  rowIds: (range.rowIds || []).map(String),
  allRows: Boolean(range.allRows),
});

const toRowDTO = (row) => ({
  id: id(row._id),
  position: row.position,
  cells: row.cells || {},
  /** Per-cell styling; absent keys mean "default", so an unstyled sheet sends {}. */
  formats: row.formats || {},
  version: row.version,
  updatedAt: row.updatedAt,
});

/**
 * One entry in the share list.
 *
 * `userId` is deliberately absent. The owner needs to see *who* — an address and
 * a name — and a stable account id would be a cross-sheet identifier handed to
 * anyone who ever owned a sheet someone was invited to, for no benefit to the UI.
 * Same reasoning as `hasAccount` on a member (serializers/index.js).
 */
const toGrantDTO = (grant) => ({
  id: id(grant._id),
  email: grant.email,
  role: grant.role,
  /** False means "invited, hasn't opened it yet" — shown as *Pending* in the list. */
  accepted: Boolean(grant.userId),
  acceptedAt: grant.acceptedAt || null,
  /** Whether the invitation email actually left. See models/sheetGrant.js. */
  notified: Boolean(grant.notifiedAt),
  fromRequest: Boolean(grant.fromRequest),
  createdAt: grant.createdAt,
});

const toRequestDTO = (request) => ({
  id: id(request._id),
  email: request.email,
  name: request.name || "",
  message: request.message || "",
  requestedRole: request.requestedRole,
  status: request.status,
  createdAt: request.createdAt,
  expiresAt: request.expiresAt,
});

/**
 * What someone *without* access is allowed to see: a title, an owner, and
 * whether they have already asked. Never anything derived from the contents —
 * see sheetAccessService.previewOf.
 */
const toSheetPreviewDTO = (preview) => ({
  title: preview.title,
  shareCode: preview.shareCode,
  ownerName: preview.ownerName || "",
  ownerEmail: preview.ownerEmail || "",
  requestPending: Boolean(preview.requestPending),
  requestedAt: preview.requestedAt || null,
});

module.exports = {
  toSheetDTO,
  toColumnDTO,
  toProtectedRangeDTO,
  toRowDTO,
  toGrantDTO,
  toRequestDTO,
  toSheetPreviewDTO,
};
