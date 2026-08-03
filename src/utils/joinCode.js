const crypto = require("crypto");
const { LIMITS } = require("../constants");
const { HUMAN_ALPHABET } = require("./linkCode");

/**
 * The short code a group can be found by without its link — read aloud across a
 * table, sent in a message, typed on a phone.
 *
 * This is deliberately NOT the invite code. The invite code is 96 bits and is the
 * whole security model; this is ~37 bits and could be guessed given enough attempts.
 * It is therefore optional per group, revocable at any time, and the only lookup in
 * the API behind a dedicated strict rate limiter. The trade-off is stated in
 * docs/02-HLD.md §3.4 rather than hidden.
 *
 * Same alphabet as device link codes, for the same reason: it is retyped from
 * another screen or from memory, so every misreadable character is gone.
 */

const generateJoinCode = (length = LIMITS.JOIN_CODE_LENGTH) => {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += HUMAN_ALPHABET[crypto.randomInt(HUMAN_ALPHABET.length)];
  }
  return code;
};

/**
 * People type "goa-2026", "GOA 2026" and "goa2026" meaning the same thing, so the
 * stored form is the normalised one and lookups normalise before comparing.
 */
const normalizeJoinCode = (code) =>
  String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

/**
 * Custom codes accept the full A–Z 0–9, not the reduced alphabet above.
 *
 * The two cases are genuinely different. A generated code is read off a screen by
 * someone who has never seen it, so ambiguity is the app's problem to remove. A
 * chosen code is one the user already knows — refusing "GOA2026" because it
 * contains a 0 and a 2 would reject the most natural thing anyone would type, to
 * protect them from a confusion they do not have.
 */
const isValidJoinCode = (code) => {
  const normalized = normalizeJoinCode(code);

  return (
    normalized.length >= LIMITS.JOIN_CODE_MIN && normalized.length <= LIMITS.JOIN_CODE_MAX
  );
};

module.exports = { generateJoinCode, normalizeJoinCode, isValidJoinCode };
