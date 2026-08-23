const mongoose = require("mongoose");
const { GROUP_STATUS, LIMITS, DEFAULT_CURRENCY } = require("../constants");

const groupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.GROUP_NAME_MAX,
    },
    description: {
      type: String,
      trim: true,
      maxlength: LIMITS.GROUP_DESC_MAX,
      default: "",
    },
    /** Public capability handle used in invite links — see docs/02-HLD.md §3. */
    inviteCode: {
      type: String,
      required: true,
      unique: true,
    },
    /**
     * Optional short code for joining without the link — typed in, or read aloud.
     *
     * Weaker than `inviteCode` by design (~37 bits against 96), so it is nullable,
     * revocable by the creator, and its lookup is the one route behind the strict
     * limiter. A group with no join code is reachable only by its link.
     */
    joinCode: {
      type: String,
      default: null,
      uppercase: true,
    },
    /**
     * The short code this group had when it was deleted.
     *
     * Deleting hands the live `joinCode` back so somebody can reuse `ROOM405`
     * immediately (see `groupService.deleteGroup`) — but the creator can restore a
     * deleted group, and a restore that silently dropped the code would be a
     * restore that did not restore it. Kept here, outside the unique index, so it
     * reserves nothing while it waits.
     *
     * Re-claimed on restore **only if still free**: releasing it means somebody
     * else may have taken it in the meantime, and their live group outranks a
     * deleted one's memory of it.
     */
    releasedJoinCode: {
      type: String,
      default: null,
      uppercase: true,
    },
    currency: {
      type: String,
      default: DEFAULT_CURRENCY,
      uppercase: true,
    },
    /** The device that created the group; grants creator-only privileges. */
    createdByDeviceId: {
      type: String,
      default: null,
    },
    /**
     * Denormalised for display only. Safe because it is maintained with atomic
     * $inc and no financial calculation ever reads it.
     */
    memberCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Private: nobody joins until a member says yes (docs/13-JOIN-APPROVAL.md).
     *
     * Off by default, because the product's promise is a link you share and
     * everyone is in — a group that asks permission by default is a different,
     * slower product, and most groups are four friends who all know each other.
     *
     * Turning it on gates **both** ways in, the invite link included. That is the
     * point: a link forwarded into the wrong group chat is the exact situation
     * someone reaches for this switch to fix, and gating only the typed code
     * would leave the bigger hole open.
     *
     * `default: false` is written to every new group rather than left undefined,
     * so a query for public groups does not have to know about `$exists`. Groups
     * created before this field existed read as `undefined`, which is falsy —
     * they stay public, which is what they already were.
     */
    isPrivate: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: Object.values(GROUP_STATUS),
      default: GROUP_STATUS.ACTIVE,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

groupSchema.index({ status: 1, lastActivityAt: -1 });
// Partial, not sparse — same reasoning as the expense clientRequestId index: the
// field defaults to null, and a sparse unique index would reject every group after
// the first one created without a join code.
groupSchema.index(
  { joinCode: 1 },
  { unique: true, partialFilterExpression: { joinCode: { $type: "string" } } }
);

module.exports = mongoose.model("Group", groupSchema);
