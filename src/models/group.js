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

module.exports = mongoose.model("Group", groupSchema);
