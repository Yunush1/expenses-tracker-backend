const mongoose = require("mongoose");
const { SETTLEMENT_METHODS, LIMITS, DEFAULT_CURRENCY } = require("../constants");

/**
 * A record that money physically moved from one member to another.
 * Settlements are never edited or deleted in the MVP — correcting one means
 * recording the reverse payment, which keeps the ledger honest.
 */
const settlementSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      index: true,
    },
    fromMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },
    toMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "Amount must be an integer in minor units",
      },
    },
    currencyCode: {
      type: String,
      default: DEFAULT_CURRENCY,
      uppercase: true,
    },
    method: {
      type: String,
      enum: Object.values(SETTLEMENT_METHODS),
      default: SETTLEMENT_METHODS.MANUAL,
    },
    /** Reserved for the payments phase — gateway transaction reference. */
    externalRef: {
      type: String,
      default: null,
    },
    note: {
      type: String,
      trim: true,
      maxlength: LIMITS.SETTLEMENT_NOTE_MAX,
      default: "",
    },
    settledAt: {
      type: Date,
      default: Date.now,
    },
    recordedByMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },
    clientRequestId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

settlementSchema.index({ groupId: 1, createdAt: -1, _id: -1 });
// Partial, not sparse — see the note on the equivalent expense index.
settlementSchema.index(
  { groupId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: "string" } } }
);

module.exports = mongoose.model("Settlement", settlementSchema);
