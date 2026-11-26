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
    /**
     * Which months this payment pays down — monthly groups only
     * (docs/29-BALANCE-CYCLES.md §4).
     *
     * Always computed by the server, never sent by a client: a payment without a
     * named month is spread oldest-first across what the payer owes the payee, and
     * one that names a month goes wholly to it. `Σ amountMinor` here always equals
     * the row's own `amountMinor`.
     *
     * Empty on every settlement in a continuous group and on every row written
     * before cycles existed. A monthly group reading one of those treats it as
     * belonging to the month it was paid in.
     *
     * The all-time balance never reads this. It still sums the row's
     * `amountMinor`, so every existing balance, cache and assertion is untouched.
     */
    allocations: {
      type: [
        new mongoose.Schema(
          {
            periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
            amountMinor: {
              type: Number,
              required: true,
              min: 1,
              validate: { validator: Number.isInteger, message: "Allocation must be integer minor units" },
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    /**
     * Links the two halves of an OFFSET or CARRY_FORWARD — rows written together,
     * which mean nothing apart. Null on every real payment.
     */
    pairId: { type: String, default: null },
  },
  { timestamps: true }
);

/**
 * The allocations, when present, must add up to the payment. A row that allocated
 * more or less than it moved would make one month's dues disagree with the
 * all-time balance — the two views this design promises can never drift.
 */
settlementSchema.pre("save", async function assertAllocationsBalance() {
  if (!this.allocations || this.allocations.length === 0) return;
  const total = this.allocations.reduce((sum, entry) => sum + entry.amountMinor, 0);
  if (total !== this.amountMinor) {
    throw new Error(
      `Allocation integrity violation: allocations total ${total}, settlement is ${this.amountMinor}`
    );
  }
});

settlementSchema.index({ groupId: 1, createdAt: -1, _id: -1 });
// Partial, not sparse — see the note on the equivalent expense index.
settlementSchema.index(
  { groupId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: "string" } } }
);

module.exports = mongoose.model("Settlement", settlementSchema);
