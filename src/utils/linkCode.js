const crypto = require("crypto");
const { LIMITS } = require("../constants");

/**
 * Codes for linking a second device to an existing member.
 *
 * The code is read off one screen and typed into another, so the alphabet drops
 * every character pair that gets mistyped in that situation — no O/0, I/1/L, S/5,
 * B/8, Z/2. 26 symbols over 6 positions is ~3×10⁸ combinations.
 *
 * Brute force is not defended by entropy alone; it is defended by the code being
 * single-use, expiring in ten minutes, and living behind the write rate limiter.
 * A wrong guess is looked up by hash and simply matches nothing, so a failed
 * attempt does not even reveal which member was being targeted.
 */

const ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";

const generateLinkCode = () => {
  let code = "";
  for (let i = 0; i < LIMITS.LINK_CODE_LENGTH; i += 1) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return code;
};

/**
 * Scoped to the group, so the same code string in two groups produces different
 * hashes and a code can never be replayed across groups.
 */
const hashLinkCode = (groupId, code) =>
  crypto
    .createHash("sha256")
    .update(`${String(groupId)}:${normalizeLinkCode(code)}`)
    .digest("hex");

/** Users type spaces, dashes and lowercase. None of those should matter. */
const normalizeLinkCode = (code) =>
  String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const isWellFormed = (code) => normalizeLinkCode(code).length === LIMITS.LINK_CODE_LENGTH;

module.exports = {
  generateLinkCode,
  hashLinkCode,
  normalizeLinkCode,
  isWellFormed,
  // Shared with joinCode.js — anything a human retypes wants the same alphabet.
  HUMAN_ALPHABET: ALPHABET,
};
