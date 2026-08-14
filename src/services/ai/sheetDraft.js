const aiProvider = require("./aiProvider");
const { LIMITS } = require("../../constants");

/**
 * "Make me an order slip" → a table blueprint the user can accept.
 *
 * The second thing the assistant drafts rather than answers, and it follows
 * expenseDraft.js deliberately: an intent gate, one JSON-shaped model call, hard
 * validation, and a **proposal the user confirms**. Nothing here writes.
 *
 * ## Why a blueprint instead of "the AI edits your sheet"
 *
 * A model that can write into a shared grid can also overwrite forty rows of
 * somebody's data on a misread instruction, and there is no undo that reaches
 * other people's screens. Returning a structure the user looks at and accepts
 * keeps the model on the safe side of the write boundary — the same reason an
 * expense draft is a card with an Add button rather than a saved expense.
 *
 * ## Why it is a table and not a document
 *
 * The ask is for order slips, quizzes and forms. All three are a header row plus
 * example rows, which is exactly what a sheet is — so the output shape is the
 * sheet's own shape (`columns`, `rows`) and needs no separate renderer. What the
 * model is being asked for is the *schema* someone would otherwise type by hand.
 */

/** Sensible for a starting template; the grid takes far more once it exists. */
const MAX_COLUMNS = 12;
const MAX_ROWS = 20;
const MAX_TITLE = 60;

/**
 * The gate. Cheap string matching before any model call, because the assistant's
 * ordinary job is answering questions about money and most messages are that.
 *
 * Deliberately requires a *making* verb next to a *thing* word. "How much did I
 * spend on forms" contains "form" and must not become a table.
 */
const MAKERS = /\b(make|create|build|generate|draft|design|set ?up|start|give me|need|want)\b/i;

/**
 * Things that can only ever be a table.
 *
 * Nobody logs a quiz as an expense, so a message naming one is a build request
 * whatever else it contains — including a number and the word "create", which is
 * exactly the combination the expense gate claims.
 */
const ONLY_A_TABLE =
  /\b(sheet|table|template|tracker|quiz|form|survey|questionnaire|checklist|roster|timetable|schedule|planner|inventory|attendance|register|price ?list)\b/i;

/**
 * Things that might be either.
 *
 * "Create a bill for 500" is an expense; "create a bill template" is a table.
 * The word alone cannot separate them, so these stay *behind* the expense gate
 * and only reach the builder if the add path declines — which it does when there
 * is no amount to draft.
 */
const MAYBE_A_TABLE = /\b(log|list|slip|invoice|bill|receipt|budget|order|record)\b/i;

/**
 * Add verbs that are not making verbs.
 *
 * "Log an attendance register" is a build request phrased with an add verb, and
 * a register is never an expense — so the *thing* decides and the verb only has
 * to show intent to produce something. Kept separate from MAKERS because these
 * alone are not enough: they pair with an unambiguous table below, never with an
 * ambiguous one, or "log 250 for a bill" would stop being an expense.
 */
const ADD_VERBS = /\b(add|log|record|note|put)\b/i;

/**
 * Questions are never build requests, whatever nouns they contain.
 *
 * "How much did I spend on forms last month" names a form and asks about money.
 * Without this it would survive on the noun alone once add verbs are accepted
 * above, and someone asking about their spending would get a blank table.
 */
const QUESTION = /^\s*(what|how much|how many|who|when|why|which|where|do i|did i|am i|is there|show|tell)\b/i;

const isQuestion = (text) => QUESTION.test(text.trim()) || text.trim().endsWith("?");

const looksLikeBuild = (message) => {
  const text = String(message || "");
  if (isQuestion(text)) return false;
  return MAKERS.test(text) && (ONLY_A_TABLE.test(text) || MAYBE_A_TABLE.test(text));
};

/**
 * Strong enough to outrank the expense drafter.
 *
 * The two gates overlap: `create`, `log`, `note` and `record` are add verbs as
 * well as making verbs, and the add gate needs only one of them plus any digit.
 * So "Create a 10-question quiz" satisfied it — "create" and "10" — and a quiz
 * was drafted as an expense, costing a model call to produce a card nobody
 * wanted. Naming something that is only ever a table settles it.
 */
const isDefinitelyTable = (message) => {
  const text = String(message || "");
  if (isQuestion(text)) return false;
  // Either kind of verb, because the *noun* is what settles it: "log an
  // attendance register" is a build request phrased with an add verb, and a
  // register is not something anyone expenses.
  return (MAKERS.test(text) || ADD_VERBS.test(text)) && ONLY_A_TABLE.test(text);
};

const SYSTEM_PROMPT = `You design spreadsheet templates.

Return ONLY a JSON object, no prose and no code fences:
{"title":"...","columns":["...","..."],"rows":[["...","..."]],"note":"one short sentence"}

Rules:
- "columns" holds 2 to ${MAX_COLUMNS} short header names. Title Case. No numbering.
- "rows" holds 0 to ${MAX_ROWS} example rows. Each row is an array of strings, the
  same length as "columns". Use realistic sample data, not "..." or "example".
- Leave a cell "" when a person is meant to fill it in (answers, signatures, totals).
- "title" is 2-5 words naming the thing.
- "note" is one sentence telling the user what to change first.
- Match the user's language, currency and region if they imply one.
- If the request is not a table, return {"title":"","columns":[],"rows":[]}.`;

/** Whitespace and fences the model sometimes wraps JSON in, despite being asked not to. */
const parseJson = (raw) => {
  const text = String(raw || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

const clean = (value, max) =>
  String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max);

/**
 * Everything the model returned, forced into something the sheet API will accept.
 *
 * Exported and pure, so the shaping rules are testable without a provider: this
 * is where a model's enthusiasm — forty columns, ragged rows, a 900-character
 * cell — becomes a table that fits. Returns null when there is nothing usable,
 * which the caller treats as "not a build request after all".
 */
const shape = (parsed) => {
  if (!parsed || typeof parsed !== "object") return null;

  const columns = (Array.isArray(parsed.columns) ? parsed.columns : [])
    .map((name) => clean(name, LIMITS.SHEET_COLUMN_NAME_MAX))
    .filter(Boolean)
    .slice(0, MAX_COLUMNS);

  // One column is a list, not a table, and the grid already gives you those.
  if (columns.length < 2) return null;

  /**
   * Rows are padded and truncated to the header width rather than dropped when
   * ragged. A model that returns four values for five columns has still produced
   * a useful row, and the alternative — discarding it — loses good data to a
   * formatting slip.
   */
  const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
    .filter((row) => Array.isArray(row))
    .slice(0, MAX_ROWS)
    .map((row) =>
      columns.map((_, index) => clean(row[index], LIMITS.SHEET_CELL_MAX))
    );

  return {
    kind: "SHEET",
    title: clean(parsed.title, MAX_TITLE) || "Untitled spreadsheet",
    columns,
    rows,
    note: clean(parsed.note, 160),
  };
};

/**
 * Draft a table from a sentence, or return null when it is not that kind of ask.
 *
 * `null` rather than a thrown error on every failure path — an unparseable reply
 * should fall through to the assistant's ordinary answer, not surface a stack
 * trace to somebody who asked a reasonable question.
 */
const draftSheet = async (message) => {
  if (!looksLikeBuild(message)) return null;
  if (!aiProvider.isConfigured()) return null;

  let parsed;
  try {
    const raw = await aiProvider.complete({
      system: SYSTEM_PROMPT,
      user: String(message).slice(0, 500),
      // Enough for twelve headers and twenty rows of sample data.
      maxTokens: 900,
      /**
       * Higher than the finance answers' 0.2. This one is asked to *invent* a
       * plausible structure rather than report a number, and at 0.2 every
       * request for a quiz comes back with the same four columns.
       */
      temperature: 0.5,
    });
    parsed = parseJson(raw);
  } catch {
    return null;
  }

  return shape(parsed);
};

module.exports = { draftSheet, looksLikeBuild, isDefinitelyTable, shape, SYSTEM_PROMPT };
