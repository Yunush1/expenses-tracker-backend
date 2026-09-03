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
 * The readable copy of a calculation.
 *
 * Every string here is text a person typed, which is a different kind of field
 * from the base64 payload above and is treated like one: hard length caps, hard
 * array caps, and numbers that must be numbers. Nothing renders these as markup,
 * and nothing should start to.
 *
 * Optional throughout. A client that sends only the payload is still valid — the
 * payload is the contract, and this is a mirror of it.
 */
const shareData = z
  .object({
    currency: z.string().length(3).optional(),
    people: z
      .array(
        z.object({
          name: z.string().max(LIMITS.SHARE_LINK_NAME_MAX).default(""),
          expenses: z
            .array(
              z.object({
                what: z.string().max(LIMITS.SHARE_LINK_WHAT_MAX).default(""),
                amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                excluded: z
                  .array(z.number().int().min(0))
                  .max(LIMITS.SHARE_LINK_PEOPLE_MAX)
                  .default([]),
              })
            )
            .max(LIMITS.SHARE_LINK_EXPENSES_MAX)
            .default([]),
        })
      )
      .max(LIMITS.SHARE_LINK_PEOPLE_MAX),
  })
  .optional();

const createShareLink = z.object({
  data: shareData,
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
 * An update: the new payload, and which copy it was based on.
 *
 * `revision` is optional in shape and effectively required in practice — a client
 * that omits it is asking for last-write-wins, which only a client written before
 * revisions existed would want. Kept optional so that one keeps working rather
 * than starting to 400.
 */
const updateShareLink = z.object({
  payload,
  data: shareData,
  revision: z.coerce.number().int().min(1).optional(),
});

const shareCodeParams = z.object({
  code: z.string().regex(SHARE_CODE_PATTERN, "Not a share link"),
});

module.exports = { createShareLink, updateShareLink, shareCodeParams };
