const test = require("node:test");
const assert = require("node:assert/strict");

const { looksLikeBuild, shape } = require("../src/services/ai/sheetDraft");
const { BUILD_STARTERS } = require("../src/services/ai/suggestions");
const { LIMITS } = require("../src/constants");

/**
 * The two halves of "make me an order slip" that do not need a model.
 *
 * The gate decides whether a message costs a provider call at all, and the
 * shaper decides what a model's reply becomes. Both are pure, and both are where
 * this feature goes wrong if it goes wrong: a gate that is too eager turns
 * ordinary questions into tables, and a shaper that trusts the reply sends the
 * sheet API a row of nulls.
 */

test("the gate needs a making verb next to a thing worth making", () => {
  for (const message of [
    "make an order slip",
    "Create a quiz for my class",
    "build a feedback form",
    "generate an invoice template",
    "I need a budget tracker",
    "set up an attendance register",
  ]) {
    assert.equal(looksLikeBuild(message), true, message);
  }
});

test("and lets ordinary questions through to the finance assistant", () => {
  for (const message of [
    // Contains "form" and "spend" but is a question about money, not a request
    // to build anything — the case that would be most annoying to get wrong.
    "how much did I spend on forms last month",
    "what did I spend this month",
    "who owes me money",
    "show me my biggest expense",
    // A thing word with no making verb.
    "the order was wrong",
    // A making verb with nothing to make.
    "create",
  ]) {
    assert.equal(looksLikeBuild(message), false, message);
  }
});

test("a well-formed reply becomes a blueprint", () => {
  const result = shape({
    title: "Bakery Order Slip",
    columns: ["Item", "Qty", "Price"],
    rows: [["Croissant", "2", "90"]],
    note: "Change the items to your own.",
  });

  assert.equal(result.kind, "SHEET");
  assert.equal(result.title, "Bakery Order Slip");
  assert.deepEqual(result.columns, ["Item", "Qty", "Price"]);
  assert.deepEqual(result.rows, [["Croissant", "2", "90"]]);
});

test("a ragged row is padded to the header width rather than dropped", () => {
  // A model that returns two values for three columns has still produced a
  // useful row; discarding it would lose good data to a formatting slip.
  const result = shape({
    title: "T",
    columns: ["A", "B", "C"],
    rows: [["one", "two"], ["x", "y", "z", "extra"]],
  });

  assert.deepEqual(result.rows[0], ["one", "two", ""]);
  assert.deepEqual(result.rows[1], ["x", "y", "z"], "extra values are cut to the width");
});

test("column and row counts are capped", () => {
  const result = shape({
    title: "Huge",
    columns: Array.from({ length: 40 }, (_, i) => `C${i}`),
    rows: Array.from({ length: 100 }, () => ["v"]),
  });

  assert.ok(result.columns.length <= 12, `got ${result.columns.length} columns`);
  assert.ok(result.rows.length <= 20, `got ${result.rows.length} rows`);
});

test("long names and cells are truncated to what the sheet accepts", () => {
  const result = shape({
    title: "x".repeat(500),
    columns: ["a".repeat(500), "B"],
    rows: [["c".repeat(5000), "ok"]],
  });

  assert.ok(result.title.length <= 60);
  assert.ok(result.columns[0].length <= LIMITS.SHEET_COLUMN_NAME_MAX);
  assert.ok(result.rows[0][0].length <= LIMITS.SHEET_CELL_MAX);
});

test("newlines and tabs in a header cannot break the grid", () => {
  const result = shape({ title: "T", columns: ["Item\nName", "Qty\tEach"], rows: [] });
  assert.deepEqual(result.columns, ["Item Name", "Qty Each"]);
});

test("nothing usable returns null rather than an empty table", () => {
  // One column is a list, not a table — and the grid already gives you those.
  assert.equal(shape({ title: "T", columns: ["Only"], rows: [] }), null);
  assert.equal(shape({ title: "", columns: [], rows: [] }), null);
  assert.equal(shape({ columns: "not an array" }), null);
  assert.equal(shape(null), null);
});

test("a missing title falls back rather than creating an unnamed sheet", () => {
  const result = shape({ columns: ["A", "B"], rows: [] });
  assert.equal(result.title, "Untitled spreadsheet");
});

test("junk rows are ignored without taking the table with them", () => {
  const result = shape({
    title: "T",
    columns: ["A", "B"],
    rows: [["ok", "fine"], "not a row", null, 42],
  });
  assert.deepEqual(result.rows, [["ok", "fine"]]);
});

test("every offered starter actually reaches the builder", () => {
  // A chip that failed the gate would fall through to the finance assistant and
  // answer something else entirely — the user tapped *our* suggestion, so this
  // is the one failure they could not be blamed for.
  for (const starter of BUILD_STARTERS) {
    assert.equal(looksLikeBuild(starter), true, starter);
  }
});
