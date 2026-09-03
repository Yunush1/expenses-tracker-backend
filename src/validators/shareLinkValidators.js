const { z } = require("zod");
const { LIMITS, SHARE_LINK_KINDS } = require("../constants");
const { SHARE_CODE_PATTERN } = require("../utils/shareCode");

/**
 * ## Why the payload pattern is the important line here
 *
 * This is an unauthenticated endpoint that accepts a blob and hands back a URL
 * that serves it again. Left open, that is a free anonymous pastebin, and a free
 * anonymous pastebin on a domain people trust is somebody else's phishing host
 * within a week.
 *
 * Restricting the body to base64url does not stop someone encoding arbitrary
 * bytes — nothing could — but it does mean the stored string can never be read
 * back as HTML, a script, or a link by anything that fetches it, and it keeps the
 * endpoint shaped like the one client that legitimately calls it.
 */

const payload = z
  .string()
  .min(1, "Nothing to share")
  .max(LIMITS.SHARE_LINK_PAYLOAD_MAX, "That calculation is too large to share by link")
  .regex(/^[A-Za-z0-9_-]+$/, "Unrecognised share payload");

/**
 * The client's own secret for a link it wants to be able to edit later.
 *
 * Never stored as given — only its hash — so the length here is about entropy
 * rather than storage: 32 base64url characters is 192 bits, which is not guessed.
 * Optional, because a caller that never intends to edit should not have to invent
 * one, and because every link made before this existed has none.
 */
const ownerKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,64}$/, "Unrecognised owner key")
  .optional();

const createShareLink = z.object({
  ownerKey,
  /**
   * Defaulted rather than required: today there is one kind, and a client that
   * omits it means the calculator. Validated against the enum all the same, so
   * the day there are two, a wrong value is a 400 and not a link that resolves to
   * the wrong page.
   */
  kind: z.nativeEnum(SHARE_LINK_KINDS).default(SHARE_LINK_KINDS.GROUP_EXPENSE_CALCULATOR),
  payload,
});

/**
 * An update, which is a create minus the choice of code and plus the proof.
 *
 * `ownerKey` is required here where it is optional above: without it there is
 * nothing to check, and an update that skipped the check would let anybody
 * rewrite any link they could see the code of.
 */
const updateShareLink = z.object({
  payload,
  ownerKey: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/, "Unrecognised owner key"),
});

const shareCodeParams = z.object({
  code: z.string().regex(SHARE_CODE_PATTERN, "Not a share link"),
});

module.exports = { createShareLink, updateShareLink, shareCodeParams };
