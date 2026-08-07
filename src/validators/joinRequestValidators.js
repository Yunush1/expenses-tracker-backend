const { z } = require("zod");
const { trimmedString } = require("./common");
const { LIMITS } = require("../constants");

/**
 * Shape only. Whether the code matches a real group is decided in
 * joinRequestService, which reports a wrong code and a deleted group identically
 * so neither confirms that some other group exists.
 */
const createJoinRequestSchema = z.object({
  code: z.string().trim().min(LIMITS.JOIN_CODE_MIN).max(LIMITS.JOIN_CODE_MAX),
  name: trimmedString(LIMITS.MEMBER_NAME_MAX, "Your name"),
});

/**
 * An explicit word rather than a boolean.
 *
 * `{ approve: false }` and a missing field look identical after JSON parsing, and
 * the difference between them is whether a stranger gets into a group. A literal
 * union means a malformed body is rejected instead of silently taken as a
 * decision nobody made.
 */
const decideJoinRequestSchema = z.object({
  decision: z.enum(["approve", "decline"]),
});

module.exports = { createJoinRequestSchema, decideJoinRequestSchema };
