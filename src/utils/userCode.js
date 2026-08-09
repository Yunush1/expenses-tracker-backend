const crypto = require("crypto");
const { HUMAN_ALPHABET } = require("./linkCode");

/**
 * Public identity codes — one shape, two subjects (docs/18-USER-CODE.md).
 *
 *   SPL-XXXXX-XXXXX   an account   (`user.userCode`)
 *   MBR-XXXXX-XXXXX   a group member, account or not (`member.memberCode`)
 *
 * ## Addresses, never credentials
 *
 * Holding one of these lets you *name* someone — on a loan, in a lookup — and
 * nothing else. It does not read their data, does not prove you are them, and
 * cannot bind their membership to your account. That last one matters: becoming
 * an existing member still requires the short-lived, single-use `linkCode` from
 * a device that already is that member (docs/17-MEMBER-IDENTITY.md §3), and
 * nothing in the codebase may accept a code from this file in its place. The
 * moment one of these is honoured as proof, a leaked screenshot becomes an
 * account takeover.
 *
 * ## Alphabet and length
 *
 * The alphabet is shared with the link and join codes: read off one screen and
 * typed into another, so every confusable pair is gone (O/0, I/1/L, S/5, B/8,
 * Z/2). Ten characters over 25 symbols ≈ 9.5 × 10¹³ — enough that a million
 * accounts collide with probability well under a percent, and enough that the
 * space cannot be walked to find real people to spam.
 */

const BODY_LENGTH = 5;
const USER_PREFIX = "SPL";
const MEMBER_PREFIX = "MBR";

const randomBody = () => {
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i += 1) {
    body += HUMAN_ALPHABET[crypto.randomInt(HUMAN_ALPHABET.length)];
  }
  return body;
};

/**
 * `PRE-XXXXX-XXXXX` — the prefix labels it, the groups make it sayable.
 *
 * Split down the middle rather than at a fixed offset, so changing BODY_LENGTH
 * cannot produce a trailing hyphen (`SPL-ABCDE-`) or an uneven pair. The halves
 * are cosmetic; `normalizeCode` strips them before anything is compared.
 */
const format = (prefix, body) => {
  const half = Math.ceil(body.length / 2);
  const tail = body.slice(half);
  return tail ? `${prefix}-${body.slice(0, half)}-${tail}` : `${prefix}-${body}`;
};

const generateUserCode = () => format(USER_PREFIX, randomBody());
const generateMemberCode = () => format(MEMBER_PREFIX, randomBody());

/**
 * Accept anything a human might type — lowercase, spaces, missing or extra
 * hyphens — and return the one canonical form, or "" if it is not a code.
 *
 * Canonicalising on the way in is what lets the unique index actually enforce
 * uniqueness, and what stops a lookup missing because someone omitted a hyphen.
 */
const normalizeCode = (code) => {
  const cleaned = String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  for (const prefix of [USER_PREFIX, MEMBER_PREFIX]) {
    if (!cleaned.startsWith(prefix)) continue;
    const body = cleaned.slice(prefix.length);
    if (body.length === BODY_LENGTH) return format(prefix, body);
  }

  return "";
};

/** Which kind of thing a code addresses, without hitting the database. */
const kindOf = (code) => {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  return normalized.startsWith(USER_PREFIX) ? "user" : "member";
};

const isWellFormed = (code) => normalizeCode(code) !== "";

module.exports = {
  generateUserCode,
  generateMemberCode,
  normalizeCode,
  kindOf,
  isWellFormed,
  BODY_LENGTH,
  USER_PREFIX,
  MEMBER_PREFIX,
};
