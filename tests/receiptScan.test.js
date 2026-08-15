const test = require("node:test");
const assert = require("node:assert/strict");

const receiptScan = require("../src/services/ai/receiptScan");

/**
 * Reading a photograph of a receipt (docs/10-AI-ASSISTANT.md §4.2).
 *
 * The model's output is untrusted input. It arrives from a system that is
 * *designed* to produce plausible text, which makes it the most convincing wrong
 * data this app handles — a fabricated line item looks exactly like a real one, and
 * it is about to be shown to somebody in a list they will tap Add on.
 *
 * So the assertions here are mostly about refusal:
 *
 * 1. **A number that is not a number is dropped, never repaired.** No zeros, no
 *    guesses, no "0.00" placeholders in a list of money.
 * 2. **Nothing is calculated.** The lines are transcribed; the app's own
 *    calculator does arithmetic. A mismatch against the printed total is reported,
 *    not silently balanced with an invented row.
 * 3. **The image is rejected before it is paid for.** Validation runs before the
 *    group's scan allowance is claimed, so a PDF never costs anybody a scan.
 */

/* ------------------------------ Amounts ----------------------------------- */

test("plain amounts pass through unchanged", () => {
  assert.equal(receiptScan.cleanAmount("1250.50"), "1250.50");
  assert.equal(receiptScan.cleanAmount("40"), "40");
  assert.equal(receiptScan.cleanAmount(" 99.99 "), "99.99");
});

test("currency symbols and thousands separators are stripped", () => {
  // Models return "₹1,250.50" and "Rs. 1250" however plainly they are asked not to.
  assert.equal(receiptScan.cleanAmount("₹1,250.50"), "1250.50");
  assert.equal(receiptScan.cleanAmount("Rs. 1250"), "1250");
  assert.equal(receiptScan.cleanAmount("$40.00"), "40.00");
});

test("an unreadable amount is null, never a zero", () => {
  /**
   * The property that matters most in this file. A "0.00" in a list somebody is
   * about to confirm reads as a free item rather than as a failure, and it is one
   * tap from being a real line in a shared ledger.
   */
  for (const bad of ["", null, undefined, "abc", "??", "1250,50", "-40", "0", "0.00", "1.2.3"]) {
    assert.equal(receiptScan.cleanAmount(bad), null, `"${bad}" must be dropped`);
  }
});

test("an absurd amount is refused rather than clamped", () => {
  // A misread decimal point is the likeliest cause, and clamping would hide it.
  assert.equal(receiptScan.cleanAmount("999999999999999"), null);
  assert.equal(receiptScan.cleanAmount("10000001"), null);
});

test("more than two decimal places is not money", () => {
  assert.equal(receiptScan.cleanAmount("12.345"), null);
  assert.equal(receiptScan.cleanAmount("12.34"), "12.34");
});

/* -------------------------------- Dates ----------------------------------- */

test("a real, past date is kept", () => {
  assert.equal(receiptScan.cleanDate("2026-08-01"), "2026-08-01");
});

test("a future date is a misread year, not a prophecy", () => {
  assert.equal(receiptScan.cleanDate("2099-01-01"), null);
});

test("anything that is not YYYY-MM-DD is dropped", () => {
  for (const bad of ["", null, "01/08/2026", "August 1", "2026-8-1", "not a date", "2026-13-45"]) {
    assert.equal(receiptScan.cleanDate(bad), null, `"${bad}" must be dropped`);
  }
});

/* ------------------------------- Images ----------------------------------- */

/** A data URL of a given decoded size, without allocating a real image. */
const fakeImage = (bytes, mime = "image/jpeg") =>
  `data:${mime};base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;

test("a plausible photo is accepted", () => {
  assert.equal(receiptScan.validateImage(fakeImage(200 * 1024)), null);
  assert.equal(receiptScan.validateImage(fakeImage(200 * 1024, "image/png")), null);
  assert.equal(receiptScan.validateImage(fakeImage(200 * 1024, "image/webp")), null);
});

test("anything that is not an image is refused, and says so plainly", () => {
  for (const bad of [
    "",
    null,
    undefined,
    42,
    "https://example.com/receipt.jpg",
    "data:application/pdf;base64,AAAA",
    "data:text/html;base64,AAAA",
    // The classic: a data URL whose payload is not base64 at all.
    "data:image/jpeg;base64,<script>alert(1)</script>",
  ]) {
    const message = receiptScan.validateImage(bad);
    assert.ok(message, `${JSON.stringify(bad)} must be refused`);
    assert.match(message, /photo|image|small|large/i);
  }
});

test("an oversized photo is refused before anything is charged for it", () => {
  /**
   * This runs *before* the group's scan allowance is claimed
   * (services/receiptService). Charging somebody a receipt scan for uploading a
   * 30 MB original would be taking something for nothing.
   */
  const message = receiptScan.validateImage(fakeImage(50 * 1024 * 1024));
  assert.match(message, /too large/i);
});

test("a file too small to be a photograph is refused", () => {
  assert.match(receiptScan.validateImage(fakeImage(100)), /too small/i);
});

test("size is measured decoded, not encoded", () => {
  /**
   * Base64 inflates by a third. Measuring the string would reject photos a third
   * smaller than the documented limit, which shows up as an upload failing at a
   * size nobody wrote down.
   */
  assert.equal(receiptScan.decodedBytes("AAAA"), 3);
  assert.equal(receiptScan.decodedBytes("AAA="), 2);
  assert.equal(receiptScan.decodedBytes("AA=="), 1);

  // Whitespace inside a data URL is legal and must not inflate the measurement.
  assert.equal(receiptScan.decodedBytes("AA AA"), 3);
});

/* ------------------------------- The prompt -------------------------------- */

test("the model is told to transcribe rather than calculate", () => {
  /**
   * Asserted on the prompt itself, because it is the only place the rule exists —
   * and dropping it is a one-line edit whose consequence (a confidently computed
   * total that is not on the paper) is invisible in review.
   */
  assert.match(receiptScan.SYSTEM_PROMPT, /never add up|never compute/i);
  assert.match(receiptScan.SYSTEM_PROMPT, /never invent/i);
  // Subtotals and tax lines are not items; folding them in would double the bill.
  assert.match(receiptScan.SYSTEM_PROMPT, /skip subtotals/i);
});
