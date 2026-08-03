const { z } = require("zod");
const { trimmedString } = require("./common");
const { LIMITS, DEFAULT_CURRENCY } = require("../constants");

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
  currency: z.string().trim().length(3).toUpperCase().optional().default(DEFAULT_CURRENCY),
  joinCode,
});

const updateGroupSchema = z
  .object({
    name: trimmedString(LIMITS.GROUP_NAME_MAX, "Group name").optional(),
    description: z.string().trim().max(LIMITS.GROUP_DESC_MAX).optional(),
    joinCode,
  })
  .refine(
    (data) =>
      data.name !== undefined || data.description !== undefined || data.joinCode !== undefined,
    { message: "Provide a name, description or join code to update" }
  );

const lookupQuerySchema = z.object({
  code: z.string().trim().min(1, "Enter a group code").max(24),
});

module.exports = { createGroupSchema, updateGroupSchema, lookupQuerySchema };
