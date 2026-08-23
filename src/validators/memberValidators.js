const { z } = require("zod");
const { objectId, trimmedString } = require("./common");
const { normalizeUpiId, isValidUpiId } = require("../utils/upi");
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

/**
 * A UPI id, normalised before it is checked (docs/16-TODO.md §2.4).
 *
 * The transform runs first on purpose: people paste ` Rahul@OKHDFCBANK ` out of
 * a bank app, and rejecting that as malformed when the only problem is a capital
 * letter and a space would be the validator inventing an error. Normalising then
 * checking means the value that reaches the model is the value that was checked —
 * `utils/upi.js` owns both halves so they cannot drift.
 *
 * There is no `.optional()`: clearing an id is `DELETE`, not `PUT` with an empty
 * string. Two ways to say "remove it" is two code paths to keep in agreement.
 */
const upiIdSchema = z.object({
  upiId: z
    .string({ message: "Enter a UPI id" })
    .max(LIMITS.UPI_ID_MAX * 2, "That is not a UPI id")
    .transform((value) => normalizeUpiId(value) || "")
    .refine(isValidUpiId, {
      message: "That doesn't look like a UPI id. They look like name@bank — for example rahul@okhdfcbank.",
    }),
});

module.exports = {
  joinGroupSchema: nameSchema,
  addMemberSchema: nameSchema,
  renameMemberSchema: nameSchema,
  claimMemberSchema,
  linkDeviceSchema,
  mergeMemberSchema,
  upiIdSchema,
  memberParamsSchema,
};
