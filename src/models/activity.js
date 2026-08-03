const mongoose = require("mongoose");
const { ACTIVITY_TYPES } = require("../constants");

/**
 * Append-only event log. No update or delete path exists in the repository —
 * the timeline is the group's shared, auditable record of what happened.
 */
const activitySchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(ACTIVITY_TYPES),
      required: true,
    },
    actorMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
    },
    /**
     * Denormalised snapshot of the actor's name at write time, so the timeline
     * stays readable after a rename or a removal.
     */
    actorName: {
      type: String,
      default: "Someone",
    },
    message: {
      type: String,
      required: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

activitySchema.index({ groupId: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model("Activity", activitySchema);
