const { z } = require("zod");
const { trimmedString } = require("./common");
const { LIMITS, DEFAULT_CURRENCY } = require("../constants");

const createGroupSchema = z.object({
  name: trimmedString(LIMITS.GROUP_NAME_MAX, "Group name"),
  description: z.string().trim().max(LIMITS.GROUP_DESC_MAX).optional().default(""),
  creatorName: trimmedString(LIMITS.MEMBER_NAME_MAX, "Your name"),
  currency: z.string().trim().length(3).toUpperCase().optional().default(DEFAULT_CURRENCY),
});

const updateGroupSchema = z
  .object({
    name: trimmedString(LIMITS.GROUP_NAME_MAX, "Group name").optional(),
    description: z.string().trim().max(LIMITS.GROUP_DESC_MAX).optional(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: "Provide a name or description to update",
  });

module.exports = { createGroupSchema, updateGroupSchema };
