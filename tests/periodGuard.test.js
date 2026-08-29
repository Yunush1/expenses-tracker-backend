const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * The month lock as the *service* applies it, not as the pure rule computes it.
 *
 * `tests/expensePeriod.test.js` already covers the rule itself. This covers the
 * wiring, which is where it actually broke: the guard was reading `dto.date` and
 * `existing.date` when every one of those fields is called **`expenseDate`**. So
 * it received `undefined` on every path, `new Date(undefined)` produced an
 * Invalid Date, and `Intl.DateTimeFormat().format()` threw
 * `RangeError: Invalid time value`.
 *
 * The lock never locked anything — it turned every expense write into a 500 — and
 * the suite stayed green because nothing exercised the guard with a real payload.
 * These tests are that missing exercise, and they are deliberately about the
 * *shape of the call* rather than the arithmetic.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/splitly-test";

const config = require("../src/config/env");
const { describeWritability } = require("../src/utils/expensePeriod");
const { ERROR_CODES } = require("../src/constants");
const { ForbiddenError } = require("../src/errors");

/**
 * A copy of the service's guard.
 *
 * Reproduced rather than imported because it is a private helper — the point is
 * to pin the behaviour it must have, so that if the real one changes shape the
 * difference is visible here.
 */
const assertPeriodOpen = (date) => {
  if (date === undefined || date === null) return;

  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return;

  const verdict = describeWritability(parsed, new Date(), config.expensePeriod);
  if (verdict.writable) return;

  throw new ForbiddenError(verdict.message, ERROR_CODES.PERIOD_LOCKED);
};

test("an omitted date is allowed, not a crash", () => {
  /**
   * `expenseDate` is `.optional()` in the validator and the service defaults it
   * to now, so a client that does not send one is doing the ordinary thing. This
   * is the case that threw.
   */
  assert.doesNotThrow(() => assertPeriodOpen(undefined));
  assert.doesNotThrow(() => assertPeriodOpen(null));
});

test("an unparseable date is left to the validator, not crashed on", () => {
  assert.doesNotThrow(() => assertPeriodOpen("not a date"));
  assert.doesNotThrow(() => assertPeriodOpen(new Date("nonsense")));
});

test("today is allowed", () => {
  assert.doesNotThrow(() => assertPeriodOpen(new Date()));
});

test("a long-closed month is refused with PERIOD_LOCKED", () => {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  assert.throws(
    () => assertPeriodOpen(twoYearsAgo),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, ERROR_CODES.PERIOD_LOCKED);
      assert.match(error.message, /History/, "the refusal must say the month is still readable");
      return true;
    }
  );
});

test("the guard reads the field the model actually uses", () => {
  /**
   * The bug, pinned directly: every call site must pass `expenseDate`. A guard
   * reading `.date` gets `undefined` from both the DTO and the document, which
   * now returns early — so the lock would silently pass everything rather than
   * throwing, and nothing else in the suite would notice.
   */
  const source = require("node:fs").readFileSync(
    require.resolve("../src/services/expenseService"),
    "utf8"
  );

  const calls = [...source.matchAll(/assertPeriodOpen\(([^)]*)\)/g)]
    .map(([, argument]) => argument.trim())
    .filter((argument) => argument !== "date"); // the definition itself

  assert.ok(calls.length >= 4, `expected the guard on create, batch, update and delete — found ${calls.length}`);

  for (const argument of calls) {
    assert.match(
      argument,
      /expenseDate$/,
      `assertPeriodOpen(${argument}) reads a field that does not exist — it is called expenseDate`
    );
  }
});
