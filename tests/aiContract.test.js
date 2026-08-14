const test = require("node:test");
const assert = require("node:assert/strict");

const { askSchema } = require("../src/validators/aiValidators");
const { LIMITS } = require("../src/constants");

/**
 * The `/ai/ask` request contract, and one relationship it must never lose.
 *
 * ## The bug these tests exist for
 *
 * `GET /ai/history` returns up to `LIMITS.AI_HISTORY_PAGE` saved exchanges. The
 * client rebuilds its transcript from that response and echoes the questions back on
 * the next `POST /ai/ask` so a suggestion is not offered twice. The `asked` bound was
 * a literal 20 while the history page was 30.
 *
 * The result was not one rejected request. Every question after the twentieth
 * exchange failed with
 *
 *     400 VALIDATION_ERROR: Array must contain at most 20 element(s)
 *
 * and it kept failing: the transcript is restored from the server, so reloading did
 * not help. The assistant became permanently unusable for whoever used it most, and
 * the only way out — clear the conversation — was not something the error mentioned.
 *
 * Both numbers now come from one constant. The first test below is the one that
 * matters: it fails if they are ever allowed to drift apart again.
 */

test("a request carrying a full restored conversation is accepted", () => {
  // Exactly what a client holding a maxed-out history would send back.
  const asked = Array.from({ length: LIMITS.AI_HISTORY_PAGE }, (_, i) => `question number ${i}`);

  const result = askSchema.safeParse({ question: "create a sheet for a quiz", asked });

  assert.equal(
    result.success,
    true,
    `a conversation of ${LIMITS.AI_HISTORY_PAGE} exchanges must be accepted — the history endpoint returns that many`
  );
});

test("the asked bound is the history page size, not a number near it", () => {
  // One past the bound is refused: the limit is still a limit.
  const tooMany = Array.from({ length: LIMITS.AI_HISTORY_PAGE + 1 }, (_, i) => `q${i}`);
  assert.equal(askSchema.safeParse({ question: "hello there", asked: tooMany }).success, false);
});

test("asked is optional and may be empty", () => {
  // The first question of a fresh conversation sends neither.
  assert.equal(askSchema.safeParse({ question: "what did I spend" }).success, true);
  assert.equal(askSchema.safeParse({ question: "what did I spend", asked: [] }).success, true);
});

test("the question itself is still bounded", () => {
  assert.equal(askSchema.safeParse({ question: "hi" }).success, false, "too short");
  assert.equal(askSchema.safeParse({ question: "" }).success, false, "empty");
  assert.equal(askSchema.safeParse({}).success, false, "missing");
  assert.equal(askSchema.safeParse({ question: "x".repeat(501) }).success, false, "too long");
  assert.equal(askSchema.safeParse({ question: "x".repeat(500) }).success, true, "at the limit");
});

test("a single previous exchange is allowed, and bounded", () => {
  assert.equal(
    askSchema.safeParse({
      question: "and last month?",
      previousQuestion: "what did I spend this month",
      previousAnswer: "You spent ₹4,200.",
    }).success,
    true
  );

  // The answer bound is larger than the question bound because an answer is prose.
  assert.equal(
    askSchema.safeParse({ question: "and last month?", previousAnswer: "x".repeat(2001) }).success,
    false
  );
});

test("an individual asked entry cannot exceed a question's length", () => {
  // Each entry is a question that was asked, so it inherits the same ceiling.
  assert.equal(askSchema.safeParse({ question: "hello there", asked: ["x".repeat(501)] }).success, false);
  assert.equal(askSchema.safeParse({ question: "hello there", asked: ["x".repeat(500)] }).success, true);
});
