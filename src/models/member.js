const mongoose = require("mongoose");
const { LIMITS } = require("../constants");

const memberSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.MEMBER_NAME_MAX,
    },
    /**
     * Links a browser to this member. Null for members added manually by someone
     * else — those can be claimed later via the invite link.
     */
    deviceId: {
      type: String,
      default: null,
    },
    isCreator: {
      type: Boolean,
      default: false,
    },
    /** Removal is a deactivation, so historical expenses keep resolving their names. */
    isActive: {
      type: Boolean,
      default: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    /** Reserved for the authentication phase — see docs/02-HLD.md §9. */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: true }
);

memberSchema.index({ groupId: 1, isActive: 1 });
memberSchema.index({ groupId: 1, deviceId: 1 });

// Member names are intentionally NOT unique — two people called "Rahul" is a real
// scenario, and rejecting it would be worse than showing both.

module.exports = mongoose.model("Member", memberSchema);
