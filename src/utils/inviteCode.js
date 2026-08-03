const crypto = require("crypto");
const { LIMITS } = require("../constants");

/**
 * Generates the public group handle used in invite links.
 *
 * Possession of this code grants member-level access (a capability URL), so it must
 * not be guessable: 16 characters from a 64-symbol alphabet is 96 bits of entropy,
 * drawn from a CSPRNG. See docs/02-HLD.md §3.4 for the security posture.
 *
 * Uses crypto directly rather than nanoid because nanoid v5 is ESM-only and this
 * codebase is CommonJS — one fewer interop problem for eight lines of code.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const MASK = ALPHABET.length - 1; // 63 — alphabet length is a power of two, so no modulo bias

const generateInviteCode = (length = LIMITS.INVITE_CODE_LENGTH) => {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i += 1) code += ALPHABET[bytes[i] & MASK];
  return code;
};

const INVITE_CODE_PATTERN = /^[0-9A-Za-z_-]{8,32}$/;

const isValidInviteCode = (value) => typeof value === "string" && INVITE_CODE_PATTERN.test(value);

module.exports = { generateInviteCode, isValidInviteCode, INVITE_CODE_PATTERN, ALPHABET };
