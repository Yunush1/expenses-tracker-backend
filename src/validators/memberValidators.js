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

module.exports = {
  joinGroupSchema: nameSchema,
  addMemberSchema: nameSchema,
  renameMemberSchema: nameSchema,
  claimMemberSchema,
  memberParamsSchema,
};
