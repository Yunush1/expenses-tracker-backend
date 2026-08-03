const test = require("node:test");
const assert = require("node:assert/strict");

const {
  scaleFor,
  toMinor,
  toMajor,
  assertMinor,
  sumMinor,
  formatMinor,
} = require("../src/utils/money");
const { ERROR_CODES, LIMITS } = require("../src/constants");

/**
 * These tests exist because `0.1 + 0.2 !== 0.3`. Every one of them is guarding the
 * boundary where a user's decimal string becomes the integer the rest of the system
 * is allowed to do arithmetic on.
 */

test("scaleFor knows the currencies that are not two-decimal", () => {
  assert.equal(scaleFor("INR"), 100);
  assert.equal(scaleFor("JPY"), 1);
  // An unknown currency falls back to 2 decimals rather than throwing mid-request.
  assert.equal(scaleFor("XYZ"), 100);
  assert.equal(scaleFor(), 100);
});

test("toMinor converts the decimals that float multiplication gets wrong", () => {
  // 12.34 * 100 is 1233.9999999999998 in IEEE-754.
  assert.equal(toMinor(12.34), 1234);
  assert.equal(toMinor(0.29), 29);
  assert.equal(toMinor(19.99), 1999);
  assert.equal(toMinor(100), 10000);
});

test("toMinor accepts the numeric strings a form actually submits", () => {
  assert.equal(toMinor("12.34"), 1234);
  assert.equal(toMinor("  250.50  "), 25050);
});

test("toMinor respects the currency's scale", () => {
  assert.equal(toMinor(500, "JPY"), 500);
  assert.equal(toMinor(12.34, "USD"), 1234);
});

test("toMinor rejects amounts that are not positive numbers", () => {
  for (const bad of [0, -5, NaN, Infinity, "abc", null, undefined, {}]) {
    assert.throws(() => toMinor(bad), { code: ERROR_CODES.INVALID_AMOUNT });
  }
});

test("toMinor rejects precision it would have to silently discard", () => {
  assert.throws(() => toMinor(12.345), { code: ERROR_CODES.INVALID_AMOUNT });
  // 1.005 is three decimal places, and 1.005 * 100 is 100.49999999999999 — rounding
  // it to 100 would quietly charge a paise less than the user typed.
  assert.throws(() => toMinor(1.005), { code: ERROR_CODES.INVALID_AMOUNT });
  // JPY has no minor unit at all, so any decimal is a mistake.
  assert.throws(() => toMinor(12.5, "JPY"), { code: ERROR_CODES.INVALID_AMOUNT });
});

test("toMinor enforces the maximum amount", () => {
  assert.equal(toMinor(LIMITS.MAX_AMOUNT_MAJOR), LIMITS.MAX_AMOUNT_MAJOR * 100);
  assert.throws(() => toMinor(LIMITS.MAX_AMOUNT_MAJOR + 1), {
    code: ERROR_CODES.INVALID_AMOUNT,
  });
});

test("toMajor round-trips every two-decimal amount unchanged", () => {
  for (let minor = 1; minor <= 5000; minor += 1) {
    assert.equal(toMinor(toMajor(minor)), minor);
  }
});

test("assertMinor lets integers through and stops everything else", () => {
  assert.equal(assertMinor(1234), 1234);
  assert.equal(assertMinor(0), 0);
  assert.equal(assertMinor(-500), -500);

  for (const bad of [12.5, NaN, Infinity, "100", null, undefined]) {
    assert.throws(() => assertMinor(bad), { code: ERROR_CODES.INVALID_AMOUNT });
  }
});

test("sumMinor adds integers and refuses to add anything else", () => {
  assert.equal(sumMinor([]), 0);
  assert.equal(sumMinor([100, 200, -50]), 250);
  assert.throws(() => sumMinor([100, 12.5]), { code: ERROR_CODES.INVALID_AMOUNT });
});

test("formatMinor renders the symbol, grouping and sign", () => {
  assert.equal(formatMinor(123456), "₹1,234.56");
  assert.equal(formatMinor(0), "₹0.00");
  assert.equal(formatMinor(-5000), "-₹50.00");
  assert.equal(formatMinor(500, "JPY"), "¥500");
  assert.equal(formatMinor(123456, "USD"), "$1,234.56");
});
