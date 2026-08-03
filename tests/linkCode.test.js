const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateLinkCode,
  hashLinkCode,
  normalizeLinkCode,
  isWellFormed,
} = require("../src/utils/linkCode");
const { LIMITS } = require("../src/constants");

/**
 * The code a second device types in to become an existing member rather than a new
 * one. It is read off one screen and typed into another, so most of what matters
 * here is tolerance of how people actually retype things.
 */

test("a generated code is the advertised length", () => {
  for (let i = 0; i < 200; i += 1) {
    assert.equal(generateLinkCode().length, LIMITS.LINK_CODE_LENGTH);
  }
});

test("the alphabet excludes every character pair that gets misread", () => {
  // O/0, I/1, L, S/5, B/8, Z/2 — the ones that cost a support conversation.
  const forbidden = /[O0I1LS5B8Z2]/;

  for (let i = 0; i < 500; i += 1) {
    const code = generateLinkCode();
    assert.doesNotMatch(code, forbidden, `generated an ambiguous code: ${code}`);
  }
});

test("codes are not obviously predictable", () => {
  const codes = new Set();
  for (let i = 0; i < 500; i += 1) codes.add(generateLinkCode());

  // 25^6 possibilities; 500 draws colliding more than a couple of times would mean
  // the generator is not actually random.
  assert.ok(codes.size >= 498, `only ${codes.size} distinct codes in 500 draws`);
});

test("normalising forgives case, spaces and dashes", () => {
  assert.equal(normalizeLinkCode("a1b2c3"), "A1B2C3");
  assert.equal(normalizeLinkCode(" A1B2-C3 "), "A1B2C3");
  assert.equal(normalizeLinkCode("a1 b2 c3"), "A1B2C3");
  assert.equal(normalizeLinkCode(null), "");
  assert.equal(normalizeLinkCode(undefined), "");
});

test("a code typed any of those ways hashes to the same value", () => {
  const groupId = "652f8a1b2c3d4e5f6a7b8c9d";
  const canonical = hashLinkCode(groupId, "A1B2C3");

  assert.equal(hashLinkCode(groupId, "a1b2c3"), canonical);
  assert.equal(hashLinkCode(groupId, " a1b2-c3 "), canonical);
});

test("the same code in a different group hashes differently", () => {
  // Scoping to the group is what stops a code being replayed elsewhere.
  const a = hashLinkCode("652f8a1b2c3d4e5f6a7b8c9d", "A1B2C3");
  const b = hashLinkCode("652f8a1b2c3d4e5f6a7b8c9e", "A1B2C3");

  assert.notEqual(a, b);
});

test("the stored value is a hash, not the code", () => {
  const hash = hashLinkCode("652f8a1b2c3d4e5f6a7b8c9d", "A1B2C3");

  assert.equal(hash.length, 64, "expected sha256 hex");
  assert.doesNotMatch(hash, /A1B2C3/i);
});

test("well-formedness is about length, after normalising", () => {
  assert.equal(isWellFormed("a1b2-c3"), true);
  assert.equal(isWellFormed("A1B2C"), false);
  assert.equal(isWellFormed("A1B2C3D"), false);
  assert.equal(isWellFormed(""), false);
});
