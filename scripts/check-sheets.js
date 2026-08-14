/**
 * Expense sheets — access model and grid mechanics (docs/20-EXPENSE-SHEETS.md).
 *
 *   node scripts/check-sheets.js
 *
 * The assertions that matter most, in order of what would hurt if they broke:
 *
 *   1. An unverified email claims **nothing**. This is the entire security
 *      property of sharing by address (models/sheetGrant.js).
 *   2. Once bound, a grant follows the *account*, not the address — so a recycled
 *      corporate mailbox does not inherit the last holder's access.
 *   3. An explicit grant beats the public setting, so opening a sheet up never
 *      silently demotes a named editor.
 *   4. Deleting a sheet removes every grant, so a restore cannot resurrect access.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const sheetService = require("../src/services/sheetService");
const access = require("../src/services/sheetAccessService");
const Sheet = require("../src/models/sheet");
const SheetRow = require("../src/models/sheetRow");
const SheetGrant = require("../src/models/sheetGrant");
const SheetAccessRequest = require("../src/models/sheetAccessRequest");
const User = require("../src/models/user");
const {
  SHEET_ROLES,
  SHEET_VISIBILITY,
  SHEET_ACCESS_SOURCE,
  SHEET_DEFAULT_COLUMNS,
} = require("../src/constants");

let failures = 0;

const check = (label, actual, want) => {
  const pass = JSON.stringify(actual) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );
};

/** Asserts that a call refuses, and refuses with the code we meant. */
const refuses = async (label, fn, code) => {
  try {
    await fn();
    failures += 1;
    console.log(`  FAIL  ${label} (it was allowed)`);
  } catch (error) {
    const pass = error.code === code;
    if (!pass) failures += 1;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : ` (got ${error.code}, want ${code})`}`);
  }
};

(async () => {
  await connectDB();

  const stamp = Date.now();
  const mk = (suffix, extra = {}) =>
    User.create({
      firebaseUid: `uid-${suffix}-${stamp}`,
      email: `${suffix}-${stamp}@example.com`,
      displayName: suffix,
      ...extra,
    });

  const owner = await mk("owner", { emailVerified: true });
  const invitee = await mk("invitee", { emailVerified: true });
  const unverified = await mk("unverified", { emailVerified: false });
  const stranger = await mk("stranger", { emailVerified: true });

  const created = await sheetService.createSheet(owner, { title: "Q3 expenses" });
  let sheet = await Sheet.findById(created._id);
  const { shareCode } = sheet;

  console.log("--- a new sheet ---");
  check("is private by default", sheet.visibility, SHEET_VISIBILITY.PRIVATE);
  check("starts with the default columns", sheet.columns.length, SHEET_DEFAULT_COLUMNS.length);
  // Unnamed by design — letters, not a guessed schema. See SHEET_DEFAULT_COLUMNS.
  // Derived from the constant rather than spelled out, so widening the default
  // set is a one-line change and not a failing assertion in another file.
  check(
    "columns are unnamed letters",
    sheet.columns.map((c) => c.name).join(""),
    SHEET_DEFAULT_COLUMNS.map((c) => c.name).join("")
  );
  check("column keys are generated, not names", /^c[0-9a-f]{8}$/.test(sheet.columns[0].key), true);
  check("starts with three empty rows", await SheetRow.countDocuments({ sheetId: sheet._id }), 3);

  console.log("\n--- who can open it ---");
  const asOwner = await access.resolveAccess(sheet, owner);
  check("the owner owns it", asOwner.role, SHEET_ROLES.OWNER);
  check("a stranger gets nothing", (await access.resolveAccess(sheet, stranger)).role, null);
  check("signed out gets nothing", (await access.resolveAccess(sheet, null)).role, null);

  await refuses(
    "and a stranger is refused, with the request-access code",
    () => access.requireAccess(shareCode, stranger),
    "SHEET_ACCESS_DENIED"
  );

  console.log("\n--- sharing by email ---");
  await access.share(shareCode, owner, { email: invitee.email, role: SHEET_ROLES.EDITOR });

  const grantBefore = await SheetGrant.findOne({ sheetId: sheet._id, email: invitee.email });
  check("the grant exists before they ever open it", Boolean(grantBefore), true);
  check("and is not yet bound to an account", grantBefore.userId, null);

  const inviteeAccess = await access.resolveAccess(sheet, invitee);
  check("the invitee gets the role they were given", inviteeAccess.role, SHEET_ROLES.EDITOR);
  check("via a grant, not the public setting", inviteeAccess.source, SHEET_ACCESS_SOURCE.GRANT);

  const grantAfter = await SheetGrant.findOne({ sheetId: sheet._id, email: invitee.email });
  check("opening it binds the grant to the account", String(grantAfter.userId), String(invitee._id));
  check("and stamps when they accepted", Boolean(grantAfter.acceptedAt), true);

  console.log("\n--- an UNVERIFIED address claims nothing (the security property) ---");
  await access.share(shareCode, owner, { email: unverified.email, role: SHEET_ROLES.EDITOR });
  const unverifiedAccess = await access.resolveAccess(sheet, unverified);
  check("no access on an unproved address", unverifiedAccess.role, null);
  check(
    "and the grant is left unbound",
    (await SheetGrant.findOne({ sheetId: sheet._id, email: unverified.email })).userId,
    null
  );
  await refuses(
    "the refusal tells them to verify, not to ask",
    () => access.requireAccess(shareCode, unverified),
    "SHEET_EMAIL_UNVERIFIED"
  );

  // ...and the moment it is verified, the same account walks straight in.
  await User.updateOne({ _id: unverified._id }, { $set: { emailVerified: true } });
  const nowVerified = await User.findById(unverified._id);
  check(
    "verifying it grants access with no re-invitation",
    (await access.resolveAccess(sheet, nowVerified)).role,
    SHEET_ROLES.EDITOR
  );

  console.log("\n--- a bound grant follows the account, not the address ---");
  await User.updateOne({ _id: invitee._id }, { $set: { email: `changed-${stamp}@example.com` } });
  const renamed = await User.findById(invitee._id);
  check(
    "changing your email keeps your access",
    (await access.resolveAccess(sheet, renamed)).role,
    SHEET_ROLES.EDITOR
  );

  // The other half: someone who *acquires* the old address inherits nothing.
  const recycled = await User.create({
    firebaseUid: `uid-recycled-${stamp}`,
    email: invitee.email, // the address the grant was originally written for
    emailVerified: true,
    displayName: "recycled",
  });
  check(
    "and a new holder of the old address inherits none of it",
    (await access.resolveAccess(sheet, recycled)).role,
    null
  );

  console.log("\n--- public, and why a grant still wins ---");
  await sheetService.updateSheet(shareCode, owner, {
    visibility: SHEET_VISIBILITY.PUBLIC,
    publicRole: SHEET_ROLES.VIEWER,
  });
  const nowPublic = await Sheet.findById(sheet._id);

  check(
    "a stranger can now view",
    (await access.resolveAccess(nowPublic, stranger)).role,
    SHEET_ROLES.VIEWER
  );
  check(
    "signed out can view too",
    (await access.resolveAccess(nowPublic, null)).role,
    SHEET_ROLES.VIEWER
  );
  check(
    "but a named EDITOR is not demoted to the public role",
    (await access.resolveAccess(nowPublic, renamed)).role,
    SHEET_ROLES.EDITOR
  );

  await refuses(
    "a public viewer still cannot edit",
    () => access.requireAccess(shareCode, stranger, SHEET_ROLES.EDITOR),
    "SHEET_EDITOR_ONLY"
  );
  await refuses(
    "and an editor cannot change sharing",
    () => sheetService.updateSheet(shareCode, renamed, { visibility: SHEET_VISIBILITY.PRIVATE }),
    "SHEET_OWNER_ONLY"
  );
  // ...but may still rename it: the split is per-field, not per-endpoint.
  const renamedSheet = await sheetService.updateSheet(shareCode, renamed, { title: "Q3 spend" });
  check("an editor CAN rename it", renamedSheet.title, "Q3 spend");

  console.log("\n--- rows ---");
  await sheetService.updateSheet(shareCode, owner, { visibility: SHEET_VISIBILITY.PRIVATE });

  const columnKey = sheet.columns[1].key; // "Description"
  const amountKey = sheet.columns[3].key; // "Amount"

  const { rows: firstPage } = await sheetService.listRows(shareCode, owner, { limit: 200 });
  const firstRow = firstPage[0];

  const written = await sheetService.updateRow(shareCode, owner, firstRow.id || firstRow._id, {
    cells: { [columnKey]: "Office chairs", [amountKey]: "12400" },
    version: firstRow.version,
  });
  check("a cell write lands", written.cells[columnKey], "Office chairs");
  check("and bumps the version", written.version, firstRow.version + 1);

  await refuses(
    "a stale version is rejected rather than silently overwriting",
    () =>
      sheetService.updateRow(shareCode, owner, firstRow.id || firstRow._id, {
        cells: { [columnKey]: "Something else" },
        version: firstRow.version,
      }),
    "VERSION_CONFLICT"
  );

  // Two people, different columns of the same row: both must succeed.
  const current = await SheetRow.findById(firstRow.id || firstRow._id);
  const patched = await sheetService.updateRow(shareCode, owner, current._id, {
    cells: { [amountKey]: "13000" },
    version: current.version,
  });
  check("a per-cell write leaves other columns alone", patched.cells[columnKey], "Office chairs");
  check("and applies the one it was given", patched.cells[amountKey], "13000");

  console.log("\n--- bulk append (the paste path) ---");
  const before = await SheetRow.countDocuments({ sheetId: sheet._id, isDeleted: false });
  await sheetService.createRows(shareCode, owner, {
    rows: Array.from({ length: 25 }, (_, index) => ({
      cells: { [columnKey]: `Pasted ${index + 1}`, [amountKey]: String((index + 1) * 100) },
    })),
  });
  const after = await SheetRow.countDocuments({ sheetId: sheet._id, isDeleted: false });
  check("25 rows appended in one call", after - before, 25);

  const ordered = await SheetRow.find({ sheetId: sheet._id, isDeleted: false })
    .sort({ position: 1 })
    .lean();
  const positions = ordered.map((row) => row.position);
  check(
    "positions are strictly increasing",
    positions.every((value, index) => index === 0 || value > positions[index - 1]),
    true
  );

  console.log("\n--- insert between, and the gap arithmetic ---");
  const anchor = ordered[1];
  const { rows: inserted } = await sheetService.createRows(shareCode, owner, {
    rows: [{ cells: { [columnKey]: "Squeezed in" } }],
    beforeRowId: String(anchor._id),
  });
  check(
    "the new row sits above its anchor",
    inserted[0].position < anchor.position && inserted[0].position > ordered[0].position,
    true
  );

  console.log("\n--- columns are renamed without touching rows ---");
  const rowsBefore = await SheetRow.find({ sheetId: sheet._id }).select("updatedAt").lean();
  await sheetService.updateColumn(shareCode, owner, columnKey, { name: "What it was for" });
  const rowsAfter = await SheetRow.find({ sheetId: sheet._id }).select("updatedAt").lean();
  check(
    "no row was rewritten by the rename",
    JSON.stringify(rowsBefore.map((r) => r.updatedAt)) ===
      JSON.stringify(rowsAfter.map((r) => r.updatedAt)),
    true
  );
  const afterRename = await sheetService.listRows(shareCode, owner, { limit: 5 });
  check(
    "and the values are still there under the same key",
    afterRename.rows[0].cells[columnKey],
    "Office chairs"
  );

  console.log("\n--- columns insert where the menu said, including the left edge ---");
  const firstKey = sheet.columns[0].key;
  const secondKey = sheet.columns[1].key;

  const { sheet: afterLeft } = await sheetService.addColumn(shareCode, owner, {
    name: "Prepended",
    beforeKey: firstKey,
  });
  check("insert-left of the first column lands at index 0", afterLeft.columns[0].name, "Prepended");
  check("and does not displace the old first column", afterLeft.columns[1].key, firstKey);

  const { sheet: afterRight } = await sheetService.addColumn(shareCode, owner, {
    name: "Inserted",
    afterKey: firstKey,
  });
  const rightAt = afterRight.columns.findIndex((c) => c.name === "Inserted");
  check("insert-right lands immediately after its anchor", afterRight.columns[rightAt - 1].key, firstKey);
  check("and immediately before what followed it", afterRight.columns[rightAt + 1].key, secondKey);

  // A menu opened just before someone else deleted that column: append rather
  // than refuse, so the user does not lose their column to a race they cannot see.
  const { sheet: afterStale } = await sheetService.addColumn(shareCode, owner, {
    name: "Orphan",
    beforeKey: "cdeadbeef",
  });
  check(
    "a key naming a vanished column appends instead of failing",
    afterStale.columns[afterStale.columns.length - 1].name,
    "Orphan"
  );

  // Put the sheet back the way the rest of the script expects to find it.
  for (const name of ["Prepended", "Inserted", "Orphan"]) {
    const doomed = afterStale.columns.find((c) => c.name === name);
    // eslint-disable-next-line no-await-in-loop
    if (doomed) await sheetService.deleteColumn(shareCode, owner, doomed.key);
  }
  sheet = await Sheet.findById(sheet._id);

  console.log("\n--- deleting a column hides its cells but keeps them recoverable ---");
  const deadKey = sheet.columns[4].key;
  await sheetService.updateRow(
    shareCode,
    owner,
    String(ordered[0]._id),
    { cells: { [deadKey]: "Riya" }, version: (await SheetRow.findById(ordered[0]._id)).version }
  );
  await sheetService.deleteColumn(shareCode, owner, deadKey);
  const afterDelete = await sheetService.listRows(shareCode, owner, { limit: 5 });
  check(
    "the deleted column's value is no longer returned",
    afterDelete.rows[0].cells[deadKey],
    undefined
  );
  const rawRow = await SheetRow.findById(ordered[0]._id);
  check("but it is still on the row", rawRow.cells.get(deadKey), "Riya");

  console.log("\n--- cell formatting ---");
  const fmtRow = await SheetRow.findById(ordered[2]._id);
  const formatted = await sheetService.updateRow(shareCode, owner, String(fmtRow._id), {
    cells: {},
    formats: { [columnKey]: { b: true, fg: "#dc2626", bg: "#fef9c3", align: "CENTER" } },
    version: fmtRow.version,
  });
  check("formatting is stored", formatted.formats[columnKey]?.b, true);
  check("and its colour survives", formatted.formats[columnKey]?.fg, "#dc2626");

  console.log("\n--- number format, font and vertical alignment ---");
  const presentation = await SheetRow.findById(fmtRow._id);
  const styled = await sheetService.updateRow(shareCode, owner, String(presentation._id), {
    cells: {},
    formats: {
      [columnKey]: { nf: "CURRENCY", dp: 2, font: "Georgia", valign: "MIDDLE" },
    },
    version: presentation.version,
  });
  check("a number format is stored", styled.formats[columnKey]?.nf, "CURRENCY");
  check("with its decimal places", styled.formats[columnKey]?.dp, 2);
  check("a whitelisted font is kept", styled.formats[columnKey]?.font, "Georgia");
  check("vertical alignment is kept", styled.formats[columnKey]?.valign, "MIDDLE");

  const rejected = await SheetRow.findById(fmtRow._id);
  const cleaned = await sheetService.updateRow(shareCode, owner, String(rejected._id), {
    cells: {},
    formats: {
      // A font is free text by nature — there is no shape that means "a font and
      // nothing else" — so the enum is the only boundary, and it must hold.
      [columnKey]: { font: "Comic Sans; }", nf: "SCIENTIFIC", dp: 99, valign: "SIDEWAYS" },
    },
    version: rejected.version,
  });
  check("an off-list font is dropped", cleaned.formats[columnKey]?.font, undefined);
  check("an unknown number format is dropped", cleaned.formats[columnKey]?.nf, undefined);
  check("out-of-range decimals are dropped", cleaned.formats[columnKey]?.dp, undefined);
  check("an unknown vertical alignment is dropped", cleaned.formats[columnKey]?.valign, undefined);

  // "Default" means "no choice made", so it must not be stored as a value.
  const defaulted = await SheetRow.findById(fmtRow._id);
  const noFont = await sheetService.updateRow(shareCode, owner, String(defaulted._id), {
    cells: {},
    formats: { [columnKey]: { font: "Default", b: true } },
    version: defaulted.version,
  });
  check("the default font stores nothing", noFont.formats[columnKey]?.font, undefined);
  check("while the rest of the format survives", noFont.formats[columnKey]?.b, true);

  // The colour check is a security boundary: these values become CSS in other
  // people's browsers. Any #rrggbb is allowed — including one that is on no
  // palette — but the value must be a colour and nothing else.
  const custom = await SheetRow.findById(fmtRow._id);
  const customSaved = await sheetService.updateRow(shareCode, owner, String(custom._id), {
    cells: {},
    formats: { [columnKey]: { fg: "#4F6EF7", bg: "#123456" } },
    version: custom.version,
  });
  check("an off-palette custom colour is accepted", customSaved.formats[columnKey]?.bg, "#123456");
  check("and is normalised to lowercase", customSaved.formats[columnKey]?.fg, "#4f6ef7");

  // Each of these is a colour the pattern must refuse. The payload in the first
  // is the reason the boundary exists at all: a second CSS declaration smuggled
  // through a style attribute, served to every collaborator on the sheet.
  for (const [label, value] of [
    ["a smuggled second declaration", "red;background:url(https://evil.test/log?c=)"],
    ["a bare colour keyword", "red"],
    ["a three-digit shorthand", "#f00"],
    ["eight digits with alpha", "#ff000080"],
    ["non-hex characters", "#gggggg"],
    ["a css function", "rgb(255,0,0)"],
    ["leading whitespace", " #ff0000"],
  ]) {
    const before = await SheetRow.findById(fmtRow._id);
    const after = await sheetService.updateRow(shareCode, owner, String(before._id), {
      cells: {},
      formats: { [columnKey]: { fg: value, bg: "#fef9c3" } },
      version: before.version,
    });
    check(`${label} is dropped`, after.formats[columnKey]?.fg, undefined);
    check("  …while a legal one alongside it is kept", after.formats[columnKey]?.bg, "#fef9c3");
  }

  console.log("\n--- protected ranges (the lock is server-side) ---");
  const editorUser = renamed; // still an EDITOR on this sheet
  await sheetService.updateSheet(shareCode, owner, { visibility: SHEET_VISIBILITY.PRIVATE });

  const lockTargetRow = await SheetRow.findById(ordered[0]._id);
  await sheetService.protectRange(shareCode, owner, {
    label: "Finance only",
    columnKeys: [amountKey],
    allRows: true,
  });

  await refuses(
    "an EDITOR cannot write a locked cell",
    async () => {
      const fresh = await SheetRow.findById(lockTargetRow._id);
      return sheetService.updateRow(shareCode, editorUser, String(fresh._id), {
        cells: { [amountKey]: "999" },
        version: fresh.version,
      });
    },
    "SHEET_RANGE_LOCKED"
  );

  await refuses(
    "nor merely re-colour it",
    async () => {
      const fresh = await SheetRow.findById(lockTargetRow._id);
      return sheetService.updateRow(shareCode, editorUser, String(fresh._id), {
        cells: {},
        formats: { [amountKey]: { bg: "#0f172a" } },
        version: fresh.version,
      });
    },
    "SHEET_RANGE_LOCKED"
  );

  const otherColumn = await SheetRow.findById(lockTargetRow._id);
  const allowedWrite = await sheetService.updateRow(shareCode, editorUser, String(otherColumn._id), {
    cells: { [columnKey]: "still editable" },
    version: otherColumn.version,
  });
  check("but an unlocked column is untouched", allowedWrite.cells[columnKey], "still editable");

  const ownerRow = await SheetRow.findById(lockTargetRow._id);
  const ownerWrite = await sheetService.updateRow(shareCode, owner, String(ownerRow._id), {
    cells: { [amountKey]: "12345" },
    version: ownerRow.version,
  });
  check("the owner is never locked out of their own sheet", ownerWrite.cells[amountKey], "12345");

  const lockedSheet = await Sheet.findById(sheet._id);
  await sheetService.unprotectRange(shareCode, owner, lockedSheet.protectedRanges[0].id);
  const unlockedRow = await SheetRow.findById(lockTargetRow._id);
  const afterUnlock = await sheetService.updateRow(shareCode, editorUser, String(unlockedRow._id), {
    cells: { [amountKey]: "777" },
    version: unlockedRow.version,
  });
  check("unlocking restores the editor's access", afterUnlock.cells[amountKey], "777");

  console.log("\n--- sorting rewrites shared order ---");
  await sheetService.sortRows(shareCode, owner, { columnKey: amountKey, direction: "asc" });
  const sorted = await sheetService.listRows(shareCode, owner, { limit: 500 });
  const numeric = sorted.rows
    .map((row) => Number(String(row.cells[amountKey] || "").replace(/[^0-9.-]/g, "")))
    .filter((value) => Number.isFinite(value) && value !== 0);
  check(
    "values come back ascending",
    numeric.every((value, index) => index === 0 || value >= numeric[index - 1]),
    true
  );

  console.log("\n--- requesting access ---");
  const { request } = await access.requestAccess(shareCode, stranger, {
    message: "Covering for Riya",
    role: SHEET_ROLES.VIEWER,
  });
  check("a request is created", request.status, "PENDING");

  const repeat = await access.requestAccess(shareCode, stranger, { role: SHEET_ROLES.VIEWER });
  check("asking twice does not create a second", repeat.alreadyPending, true);
  check(
    "still exactly one pending",
    await SheetAccessRequest.countDocuments({ sheetId: sheet._id, status: "PENDING" }),
    1
  );

  await refuses(
    "someone who already has access cannot ask",
    () => access.requestAccess(shareCode, owner, { role: SHEET_ROLES.VIEWER }),
    "SHEET_ALREADY_SHARED"
  );

  await access.decideRequest(shareCode, owner, String(request._id), {
    approve: true,
    role: SHEET_ROLES.VIEWER,
  });
  check(
    "approving grants access immediately",
    (await access.resolveAccess(await Sheet.findById(sheet._id), stranger)).role,
    SHEET_ROLES.VIEWER
  );
  check(
    "and the grant is bound at once — no email round trip",
    String((await SheetGrant.findOne({ sheetId: sheet._id, email: stranger.email })).userId),
    String(stranger._id)
  );

  await refuses(
    "the same request cannot be answered twice",
    () => access.decideRequest(shareCode, owner, String(request._id), { approve: false }),
    "SHEET_REQUEST_ALREADY_DECIDED"
  );

  console.log("\n--- revoking ---");
  const grantToKill = await SheetGrant.findOne({ sheetId: sheet._id, email: stranger.email });
  await access.revokeGrant(shareCode, owner, String(grantToKill._id));
  check(
    "revoked access is gone",
    (await access.resolveAccess(await Sheet.findById(sheet._id), stranger)).role,
    null
  );
  check(
    "and the row is really deleted, not soft-deleted",
    await SheetGrant.countDocuments({ sheetId: sheet._id, email: stranger.email }),
    0
  );

  console.log("\n--- deleting the sheet takes every grant with it ---");
  await sheetService.deleteSheet(shareCode, owner);
  check("no grants survive", await SheetGrant.countDocuments({ sheetId: sheet._id }), 0);
  check("no requests survive", await SheetAccessRequest.countDocuments({ sheetId: sheet._id }), 0);
  check(
    "rows are soft-deleted, so an operator can still restore",
    await SheetRow.countDocuments({ sheetId: sheet._id, isDeleted: false }),
    0
  );
  await refuses(
    "and the share code stops resolving",
    () => access.requireAccess(shareCode, owner),
    "SHEET_NOT_FOUND"
  );

  console.log("\n--- cleanup ---");
  await SheetRow.deleteMany({ sheetId: sheet._id });
  await Sheet.deleteOne({ _id: sheet._id });
  await User.deleteMany({
    _id: { $in: [owner._id, invitee._id, unverified._id, stranger._id, recycled._id] },
  });
  console.log("  done");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
