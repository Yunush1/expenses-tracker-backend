const crypto = require("crypto");
const { LIMITS } = require("../constants");

/**
 * The code in a `/s/<code>` short link.
 *
 * Alphanumerics only — no `-`, no `_`. The invite code can afford those two
 * because it is generated once and travels inside an `<a href>`; a share code is
 * read back off a phone screen, retyped from a screenshot, and passed through
 * chat clients that helpfully trim trailing punctuation. Every character here is
 * one that survives all three.
 *
 * `crypto.randomInt` rather than masking bytes, because 62 is not a power of two
 * and `byte % 62` would make the first four letters of the alphabet slightly more
 * likely than the rest. The same reasoning as utils/joinCode.js — see
 * utils/inviteCode.js for the case where masking *is* correct.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const generateShareCode = (length = LIMITS.SHARE_LINK_CODE_LENGTH) => {
  let code = "";
  for (let i = 0; i < length; i += 1) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
};

/**
 * Deliberately wider than the length we generate.
 *
 * Codes already in circulation outlive any decision to lengthen them, so the
 * pattern that *reads* a code must not be pinned to the length that writes one.
 */
const SHARE_CODE_PATTERN = /^[0-9A-Za-z]{4,16}$/;

const isValidShareCode = (value) => typeof value === "string" && SHARE_CODE_PATTERN.test(value);

module.exports = { generateShareCode, isValidShareCode, SHARE_CODE_PATTERN, ALPHABET };
