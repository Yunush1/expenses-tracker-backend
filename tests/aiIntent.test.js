const test = require("node:test");
const assert = require("node:assert/strict");

const { AI_INTENT, classify } = require("../src/services/ai/intent");
const { BUILD_STARTERS } = require("../src/services/ai/suggestions");

/**
 * Where a message goes, and why.
 *
 * The assistant does three different jobs and decides between them with string
 * matching before any model is called. Getting it wrong is not a crash — it is a
 * wrong-looking reply to a reasonable question, plus a model call spent
 * producing it — so the routing is worth pinning down case by case.
 */

const cases = [
  /* ------------------------- only ever a table ------------------------- */
  ["Make an order slip for a bakery", AI_INTENT.SHEET],
  ["Create a 10-question quiz on general knowledge", AI_INTENT.SHEET],
  ["Build a customer feedback form", AI_INTENT.SHEET],
  ["Make an attendance register for a class", AI_INTENT.SHEET],
  ["Create an invoice template with GST", AI_INTENT.SHEET],
  ["Build a monthly budget tracker", AI_INTENT.SHEET],
  ["set up a shift roster", AI_INTENT.SHEET],

  /* ---------------------------- an expense ---------------------------- */
  ["Add 1200 for dinner split with everyone", AI_INTENT.EXPENSE],
  ["log 250 for coffee", AI_INTENT.EXPENSE],
  ["record 4000 rent", AI_INTENT.EXPENSE],
  // A bill genuinely can be an expense, and an amount is the strongest signal
  // there is that it is one — so the ambiguous word stays behind the add gate.
  ["Create a bill for 500", AI_INTENT.EXPENSE],
  // Dictated, so the amount arrives as words. A digit-only gate answered these
  // as questions, which reads as the microphone having failed.
  ["add four hundred in group expense, me and Rahul", AI_INTENT.EXPENSE],
  ["log twelve hundred for groceries", AI_INTENT.EXPENSE],
  ["add two thousand rent", AI_INTENT.EXPENSE],

  /* ------------------- a question, which is the default ------------------ */
  ["what did I spend this month", AI_INTENT.FINANCE],
  ["who owes me money", AI_INTENT.FINANCE],
  // Contains "form" and "spend": the case that would be most annoying to
  // misroute, because the user asked about money and would get a table.
  ["How much did I spend on forms last month", AI_INTENT.FINANCE],
  ["Which group do I owe money in?", AI_INTENT.FINANCE],
  // An add verb with no amount is not an expense, and names nothing to build.
  ["add something", AI_INTENT.FINANCE],
  ["", AI_INTENT.FINANCE],
  // The cost of accepting spoken magnitudes: a number word alone must not be
  // enough, or every "add one more member" spends a drafting call.
  ["add one more member to the group", AI_INTENT.FINANCE],
  ["add a few people", AI_INTENT.FINANCE],
];

test("every message routes to exactly one job", () => {
  for (const [message, expected] of cases) {
    assert.equal(classify(message), expected, `"${message}"`);
  }
});

test("a table beats the add gate when both would claim the message", () => {
  // "create" is an add verb and a making verb; "10" is the digit the add gate
  // needs. Before the precedence rule existed this drafted a quiz as an expense.
  assert.equal(classify("Create a 10-question quiz"), AI_INTENT.SHEET);
  assert.equal(classify("log an attendance register for 30 students"), AI_INTENT.SHEET);

  // But an amount against a word that really can be money stays an expense.
  assert.equal(classify("create a bill for 500"), AI_INTENT.EXPENSE);
});

test("an ambiguous thing with no amount is a table", () => {
  // Nothing for the add gate to draft — no number — so "bill template" is the
  // template, not the bill.
  assert.equal(classify("create a bill template"), AI_INTENT.SHEET);
  assert.equal(classify("make me an invoice list"), AI_INTENT.SHEET);
});

test("every offered starter routes to the builder", () => {
  // A chip that routed elsewhere would answer something the user did not ask —
  // and they tapped *our* suggestion, so it is the one misroute they could not
  // be blamed for.
  for (const starter of BUILD_STARTERS) {
    assert.equal(classify(starter), AI_INTENT.SHEET, starter);
  }
});
