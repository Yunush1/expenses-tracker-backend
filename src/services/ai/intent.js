const expenseDraft = require("./expenseDraft");
const sheetDraft = require("./sheetDraft");

/**
 * What kind of message is this?
 *
 * One function, one answer, decided before any model is called. The alternative
 * — asking each drafter in turn whether it wants the message — spreads the
 * routing rules across three files and makes the precedence an accident of the
 * order the `if`s happen to be written in. Here the order *is* the rule, and it
 * is visible in eleven lines.
 *
 * ## Why regexes rather than asking a model to classify
 *
 * Most messages are ordinary questions about money. Paying for a model call to
 * discover that would double the cost and the latency of the common case, to
 * answer something string matching gets right. It also keeps the failure mode
 * cheap: a misroute is a wrong-looking reply, not a wrong-looking charge.
 *
 * ## The precedence, and why it is this way round
 *
 * The gates genuinely overlap — `create`, `log`, `note` and `record` are add
 * verbs *and* making verbs, and the add gate needs only one of them plus any
 * digit. So "Create a 10-question quiz" satisfied it on "create" and "10", and a
 * quiz was drafted as an expense.
 *
 * Naming something that can only ever be a table settles it, so that check goes
 * first. Everything still ambiguous — "create a bill for 500" — falls to the
 * expense gate, because a bill really can be an expense and an amount is the
 * strongest signal there is that it is one.
 */

const AI_INTENT = Object.freeze({
  /** Build a table the user can create. sheetDraft. */
  SHEET: "SHEET",
  /** Draft an expense the user can add. expenseDraft. */
  EXPENSE: "EXPENSE",
  /** Answer a question from the person's own figures. The default. */
  FINANCE: "FINANCE",
});

const classify = (message) => {
  // Only ever a table — a quiz, a roster, a form. Outranks the add gate.
  if (sheetDraft.isDefinitelyTable(message)) return AI_INTENT.SHEET;

  // An add verb and an amount. "Create a bill for 500" lands here, correctly.
  if (expenseDraft.looksLikeAdd(message)) return AI_INTENT.EXPENSE;

  // A making verb and something that *might* be a table, with no amount to
  // suggest it is money: "create a bill template".
  if (sheetDraft.looksLikeBuild(message)) return AI_INTENT.SHEET;

  return AI_INTENT.FINANCE;
};

module.exports = { AI_INTENT, classify };
