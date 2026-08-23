/**
 * UPI ids (VPAs), normalised and checked (docs/16-TODO.md §2.4).
 *
 * ## What this validates, and what it cannot
 *
 * A VPA is `identifier@handle` — `rahul@okhdfcbank`, `9876543210@ybl`. The shape
 * is checkable and that is all this file does. Whether the address exists, and
 * whether it belongs to the member who typed it, are questions only NPCI can
 * answer, and this server does not talk to NPCI and never will: doing so is the
 * regulated payments surface the PRD puts out of scope.
 *
 * So a member could paste a stranger's VPA into their own row. Three things bound
 * that, and it is worth writing them down because none is obvious:
 *
 *  1. **Only you can set yours.** `memberService.setUpiId` refuses on anyone
 *     else's row, creator included — unlike renaming, which the creator may do on
 *     behalf of someone who has not opened the link. A name is a label the group
 *     agrees on; a payment address is a claim about the outside world, and one
 *     person putting another person's bank details on a row is the whole risk.
 *  2. **The payer's own bank app shows the real account holder** before any money
 *     moves. That confirmation screen is the actual verification step, it happens
 *     outside this product, and it cannot be skipped or spoofed from here.
 *  3. **Nothing is ever inferred.** A member with no VPA has none, and the app
 *     behaves exactly as it did before this feature existed.
 *
 * ## Why the shape check is deliberately loose
 *
 * PSP handles are not a published, stable list — banks add them, and a validator
 * that hard-codes `ybl|okaxis|paytm|…` starts rejecting real addresses the week
 * after it is written. The cost of being loose is that a typo is stored and the
 * payer's UPI app says "invalid VPA", which is recoverable in seconds. The cost of
 * being strict is refusing somebody's real bank and giving them no way through.
 * The asymmetry runs towards loose.
 */

const { LIMITS } = require("../constants");

/**
 * Lower-cased, because a VPA is case-insensitive and storing `Rahul@OKHDFCBANK`
 * would mean two spellings of one address — which shows up later as a comparison
 * that fails for no visible reason.
 */
const normalizeUpiId = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
};

/**
 * `identifier@handle`, one `@`, no spaces.
 *
 * The identifier half allows the characters NPCI permits — letters, digits, dot,
 * hyphen, underscore — and must both start and end with an alphanumeric, so a
 * leading dot or a trailing hyphen (the usual copy-paste damage) is caught here
 * rather than in somebody's bank app.
 */
const UPI_ID = /^[a-z0-9]([a-z0-9._-]{0,254}[a-z0-9])?@[a-z][a-z0-9]{1,63}$/;

const isValidUpiId = (value) => {
  const normalized = normalizeUpiId(value);
  if (!normalized) return false;
  if (normalized.length > LIMITS.UPI_ID_MAX) return false;
  return UPI_ID.test(normalized);
};

module.exports = { normalizeUpiId, isValidUpiId, UPI_ID };
