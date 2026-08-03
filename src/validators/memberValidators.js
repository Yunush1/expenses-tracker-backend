const { z } = require("zod");
const { objectId, trimmedString } = require("./common");
const { LIMITS } = require("../constants");

const nameSchema = z.object({
  name: trimmedString(LIMITS.MEMBER_NAME_MAX, "Name"),
});

const claimMemberSchema = z.object({
  memberId: objectId,
});

const memberParamsSchema = z.object({
  inviteCode: z.string().min(8).max(32),
  memberId: objectId,
});

/** Users paste codes with spaces, dashes and mixed case; normalising is not their job. */
const linkDeviceSchema = z.object({
  code: z
    .string()
    .trim()
    .min(LIMITS.LINK_CODE_LENGTH, `Enter the ${LIMITS.LINK_CODE_LENGTH}-character device code`)
    .max(24, "That is not a device code"),
});

const mergeMemberSchema = z.object({
  intoMemberId: objectId,
});

module.exports = {
  joinGroupSchema: nameSchema,
  addMemberSchema: nameSchema,
  renameMemberSchema: nameSchema,
  claimMemberSchema,
  linkDeviceSchema,
  mergeMemberSchema,
  memberParamsSchema,
};
