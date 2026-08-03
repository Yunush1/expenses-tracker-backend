const mongoose = require("mongoose");
const { SPLIT_TYPES, LIMITS, DEFAULT_CURRENCY } = require("../constants");
/**
 * A share has no identity outside its expense and is always read with it, so it is
 * embedded rather than stored in its own collection: one document read returns the
 * complete expense.
 */
const shareSchema = new mongoose.Schema(
  {
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: "Share amount must be an integer in minor units",
      },
    },
  },
  { _id: false }
);

const expenseSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.EXPENSE_DESC_MAX,
    },
    /** Integer minor units (paise). Never a float — see docs/05-ALGORITHMS.md §1. */
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
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },
    splitType: {
      type: String,
      enum: Object.values(SPLIT_TYPES),
      default: SPLIT_TYPES.EQUAL,
    },
    shares: {
      type: [shareSchema],
      required: true,
      validate: {
        validator: (shares) => shares.length > 0,
        message: "An expense needs at least one participant",
      },
    },
    expenseDate: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: LIMITS.EXPENSE_NOTES_MAX,
      default: "",
    },
    /** Reserved for AI categorisation and receipt OCR — see docs/02-HLD.md §9. */
    category: {
      type: String,
      default: null,
    },
    attachments: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    createdByMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },
    /** Idempotency key — makes a retried or double-tapped submit safe. */
    clientRequestId: {
      type: String,
      default: null,
    },
    /** Optimistic concurrency: an update must present the version it read. */
    version: {
      type: Number,
      default: 0,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedByMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
    },
  },
  { timestamps: true }
);

expenseSchema.index({ groupId: 1, isDeleted: 1, expenseDate: -1, _id: -1 });
expenseSchema.index({ groupId: 1, isDeleted: 1, paidBy: 1 });
// Partial, not sparse: a sparse index only skips documents where the field is
// ABSENT, and clientRequestId defaults to null — so a sparse unique index would
// reject every expense after the first one that omitted the key.
expenseSchema.index(
  { groupId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: "string" } } }
);

/**
 * Defence in depth behind the service-layer assertion: an expense whose shares do
 * not sum to its amount would silently break the zero-sum balance invariant for
 * the whole group, so it must never reach the database.
 */
// Async style rather than the callback `next`: Mongoose 9 no longer passes one.
expenseSchema.pre("save", async function assertSharesBalance() {
  const total = this.shares.reduce((sum, share) => sum + share.amountMinor, 0);

  if (total !== this.amountMinor) {
    throw new Error(
      `Share integrity violation: shares total ${total}, expense is ${this.amountMinor}`
    );
  }
});

module.exports = mongoose.model("Expense", expenseSchema);
