const test = require("node:test");
const assert = require("node:assert/strict");

const { generateJoinCode, normalizeJoinCode, isValidJoinCode } = require("../src/utils/joinCode");
const { HUMAN_ALPHABET } = require("../src/utils/linkCode");
const { LIMITS } = require("../src/constants");

/**
 * The short code a group can be found by without its link. Two audiences, two
 * rules: what the app generates has to survive being read aloud, and what a user
 * chooses has to not be second-guessed.
 */

// ---------------------------------------------------------------------------
// Generated codes
// ---------------------------------------------------------------------------

test("a generated code is the advertised length", () => {
  for (let i = 0; i < 200; i += 1) {
    assert.equal(generateJoinCode().length, LIMITS.JOIN_CODE_LENGTH);
  }
});

test("a generated code contains nothing anyone would misread", () => {
  // Read across a table, so O/0, I/1/L, S/5, B/8, Z/2 must never appear.
  for (let i = 0; i < 500; i += 1) {
    assert.doesNotMatch(generateJoinCode(), /[O0I1LS5B8Z2]/);
  }
});

test("generated codes come from the shared human alphabet", () => {
  for (const char of generateJoinCode(64)) {
    assert.ok(HUMAN_ALPHABET.includes(char), `${char} is not in the alphabet`);
  }
});

test("generated codes do not repeat in any realistic batch", () => {
  const codes = new Set();
  for (let i = 0; i < 1000; i += 1) codes.add(generateJoinCode());

  assert.ok(codes.size >= 998, `only ${codes.size} distinct codes in 1000 draws`);
});

test("a generated code is always accepted by the validator", () => {
  for (let i = 0; i < 200; i += 1) {
    assert.equal(isValidJoinCode(generateJoinCode()), true);
  }
});

// ---------------------------------------------------------------------------
// Normalising what people actually type
// ---------------------------------------------------------------------------

test("case, spaces and dashes are all the same code", () => {
  assert.equal(normalizeJoinCode("goa2026"), "GOA2026");
  assert.equal(normalizeJoinCode("GOA-2026"), "GOA2026");
  assert.equal(normalizeJoinCode("  goa 2026  "), "GOA2026");
  assert.equal(normalizeJoinCode("g.o.a.2026"), "GOA2026");
});

test("normalising is idempotent", () => {
  const once = normalizeJoinCode("goa-2026");
  assert.equal(normalizeJoinCode(once), once);
});

test("normalising survives nothing at all", () => {
  assert.equal(normalizeJoinCode(null), "");
  assert.equal(normalizeJoinCode(undefined), "");
  assert.equal(normalizeJoinCode(""), "");
  assert.equal(normalizeJoinCode("---"), "");
});

// ---------------------------------------------------------------------------
// Chosen codes
// ---------------------------------------------------------------------------

test("a chosen code may use the full alphabet, including ambiguous characters", () => {
  // The reduced alphabet exists to protect someone reading an unfamiliar code.
  // "GOA2026" is the most natural thing a user would pick, and rejecting it for
  // containing a 0 and a 2 would protect them from a confusion they do not have.
  assert.equal(isValidJoinCode("GOA2026"), true);
  assert.equal(isValidJoinCode("BILLS2026"), true);
  assert.equal(isValidJoinCode("OFFICE01"), true);
});

test("length is enforced after normalising, not before", () => {
  // "ABC-DEF" is 7 characters typed and 6 that count.
  assert.equal(isValidJoinCode("ABC-DEF"), true);
  assert.equal(isValidJoinCode("AB-CD"), false, "5 real characters is too short");
});

test("codes that are too short or too long are refused", () => {
  const short = "A".repeat(LIMITS.JOIN_CODE_MIN - 1);
  const long = "A".repeat(LIMITS.JOIN_CODE_MAX + 1);

  assert.equal(isValidJoinCode(short), false);
  assert.equal(isValidJoinCode("A".repeat(LIMITS.JOIN_CODE_MIN)), true);
  assert.equal(isValidJoinCode("A".repeat(LIMITS.JOIN_CODE_MAX)), true);
  assert.equal(isValidJoinCode(long), false);
});

test("an empty or missing code is not valid", () => {
  assert.equal(isValidJoinCode(""), false);
  assert.equal(isValidJoinCode(null), false);
  assert.equal(isValidJoinCode(undefined), false);
  assert.equal(isValidJoinCode("!!!!!!!!"), false, "punctuation normalises away to nothing");
});

test("the minimum length keeps the search space non-trivial", () => {
  // 6 characters over 36 symbols is ~2×10⁹ — small next to the invite code's 96
  // bits, which is exactly why the lookup route is rate limited rather than relying
  // on this number. See docs/02-HLD.md §3.4.
  assert.ok(LIMITS.JOIN_CODE_MIN >= 6, "a shorter minimum would be guessable by hand");
  assert.ok(LIMITS.JOIN_CODE_LENGTH > LIMITS.JOIN_CODE_MIN, "generated codes exceed the floor");
});
