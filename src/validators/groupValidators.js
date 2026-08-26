const { z } = require("zod");
const { trimmedString } = require("./common");
const { LIMITS, DEFAULT_CURRENCY } = require("../constants");
const { SUPPORTED_CURRENCIES } = require("../utils/money");

/**
 * Shape only. Whether a code is well-formed, free, or reserved is decided in
 * groupService, so create and update share one set of rules.
 *
 * `null` is meaningful and must survive validation: it is how the creator turns the
 * short code off.
 */
const joinCode = z.union([z.string().trim().max(24), z.null()]).optional();

const createGroupSchema = z.object({
  name: trimmedString(LIMITS.GROUP_NAME_MAX, "Group name"),
  description: z.string().trim().max(LIMITS.GROUP_DESC_MAX).optional().default(""),
  creatorName: trimmedString(LIMITS.MEMBER_NAME_MAX, "Your name"),
  /**
   * An allowlist, not "any three letters".
   *
   * `utils/money.js` falls back to a scale of 100 for a code it does not know.
   * That is right for *display* — a number beats a crash — and catastrophic for
   * *storage*: a group created in KWD, which has three decimal places, would have
   * every amount stored ten times too small, with nothing reporting an error
   * (docs/27-MULTI-CURRENCY.md §3).
   *
   * A group's currency is also immutable — `updateGroupSchema` below deliberately
   * omits it, because the stored integers carry no currency of their own and
   * changing it would reinterpret every amount rather than convert it.
   */
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((code) => SUPPORTED_CURRENCIES.includes(code), {
      message: "That currency is not supported",
    })
    .optional()
    .default(DEFAULT_CURRENCY),
  joinCode,
});

const updateGroupSchema = z
  .object({
    name: trimmedString(LIMITS.GROUP_NAME_MAX, "Group name").optional(),
    description: z.string().trim().max(LIMITS.GROUP_DESC_MAX).optional(),
    joinCode,
    /** Approval for new members. See models/group.js for what it gates. */
    isPrivate: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.joinCode !== undefined ||
      data.isPrivate !== undefined,
    { message: "Provide a name, description, join code or privacy setting to update" }
  );

const lookupQuerySchema = z.object({
  code: z.string().trim().min(1, "Enter a group code").max(24),
});

module.exports = { createGroupSchema, updateGroupSchema, lookupQuerySchema };
