const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeUpiId, isValidUpiId } = require("../src/utils/upi");
const { upiIdSchema } = require("../src/validators/memberValidators");
const { LIMITS } = require("../src/constants");

/**
 * The payment address a settlement row deep-links to (docs/16-TODO.md §2.4).
 *
 * Two properties matter and they pull in opposite directions, so both are asserted
 * rather than argued about: the shape check has to be **loose enough** that a real
 * bank handle nobody wrote down in 2026 still gets through, and **tight enough**
 * that what lands in a `upi://pay?pa=…` URL cannot carry the query string
 * somewhere it was not meant to go.
 */

test("a real-world VPA is accepted in the forms people actually paste", () => {
  for (const value of [
    "rahul@okhdfcbank",
    "9876543210@ybl",
    "rahul.sharma@paytm",
    "rahul-sharma@upi",
    "rahul_sharma@apl",
    "r2@axl",
    // A handle nobody has heard of. The point of the loose check: a bank that
    // launches next year must not be refused by a list written this year.
    "someone@brandnewbankthatdidnotexist",
  ]) {
    assert.ok(isValidUpiId(value), `should have accepted ${value}`);
  }
});

test("case and stray whitespace are normalised, not rejected", () => {
  // People paste out of a bank app, and it comes with both.
  assert.equal(normalizeUpiId("  Rahul@OKHDFCBANK  "), "rahul@okhdfcbank");
  assert.ok(isValidUpiId(" Rahul@OKHDFCBANK "));
});

test("normalising is idempotent, so a stored id round-trips unchanged", () => {
  const once = normalizeUpiId(" Rahul@OKAxis ");
  assert.equal(normalizeUpiId(once), once);
});

test("nothing that could break out of the deep link is accepted", () => {
  /**
   * The stored value is interpolated into `upi://pay?pa=<id>&am=…`. Any of these
   * getting through would mean a member could append or overwrite parameters on
   * the payer's payment intent — an amount, or a second payee.
   */
  for (const value of [
    "rahul@ybl&am=99999",
    "rahul@ybl?pa=someone",
    "rahul@ybl#frag",
    "rahul @ybl",
    "rahul@ybl payee",
    "rahul@yb l",
    "rahul%40ybl@ybl",
    "rahul@ybl/../x",
    "rahul@ybl\nam=1",
  ]) {
    assert.equal(isValidUpiId(value), false, `should have refused ${value}`);
  }
});

test("a value that is not a VPA at all is refused", () => {
  for (const value of [
    "",
    "   ",
    "rahul",
    "@ybl",
    "rahul@",
    "rahul@@ybl",
    "rahul@1bank", // a handle has to start with a letter
    "rahul@y", // and be more than one character
    ".rahul@ybl", // leading punctuation is copy-paste damage
    "rahul.@ybl", // and so is trailing
    "rahul@ybl.com", // an email is the commonest wrong answer
    null,
    undefined,
    12345,
    {},
  ]) {
    assert.equal(isValidUpiId(value), false, `should have refused ${JSON.stringify(value)}`);
  }
});

test("the length cap holds", () => {
  const long = `${"a".repeat(LIMITS.UPI_ID_MAX)}@ybl`;
  assert.equal(isValidUpiId(long), false);
});

/* ----------------------------- The request schema ------------------------- */

test("the schema returns the normalised value, not the one that was typed", () => {
  // What reaches the model must be what was checked, or the two can disagree.
  const parsed = upiIdSchema.parse({ upiId: "  Rahul@OKHDFCBANK " });
  assert.equal(parsed.upiId, "rahul@okhdfcbank");
});

test("the schema refuses a malformed id with a message that says what one looks like", () => {
  const result = upiIdSchema.safeParse({ upiId: "rahul@ybl&am=99999" });
  assert.equal(result.success, false);
  assert.match(result.error.issues[0].message, /name@bank/);
});

test("the schema has no way to say 'clear it' — that is DELETE", () => {
  // Two ways to remove an address is two code paths to keep in agreement.
  for (const body of [{ upiId: "" }, { upiId: null }, {}]) {
    assert.equal(upiIdSchema.safeParse(body).success, false);
  }
});
