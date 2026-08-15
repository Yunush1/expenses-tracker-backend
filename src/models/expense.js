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

/**
 * The per-participant input a non-equal split was built from — an exact amount, a
 * percentage or a weight, always as an integer (see constants.SPLIT_VALUE_UNITS).
 *
 * Shares alone cannot be reversed back into this: 2:1:1 weights and 50/25/25 percent
 * produce identical shares, and neither can be recovered from the rupee figures. It
 * is stored so an edit that only touches the amount can re-derive the same split, and
 * so the form can reopen showing what the user actually typed. Empty for EQUAL.
 */
const splitValueSchema = new mongoose.Schema(
  {
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },
    value: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: "Split value must be an integer",
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
    splitValues: {
      type: [splitValueSchema],
      default: [],
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
    /**
     * What the receipt this came off actually said — GST, subtotal, invoice
     * number, the lot (docs/10-AI-ASSISTANT.md §4.2).
     *
     * ## Why it is on the expense and not in a collection of its own
     *
     * One receipt becomes several expenses, so this is duplicated across the lines
     * of a single bill — which looks like the wrong shape until you ask what
     * happens when somebody deletes one line, or moves it to another month, or
     * edits its amount. Each line is independently editable and independently
     * deletable, and a shared receipt row would leave orphans, dangling references
     * and a "which line still owns this?" question with no good answer.
     *
     * Duplicating a dozen small fields per line is cheap. Keeping every expense
     * able to explain itself, forever, without a join, is not.
     *
     * ## Why none of it is authoritative
     *
     * Nothing here is read by a balance, a split or a settlement. `amountMinor`
     * above is what the group owes; this is provenance — what the paper said,
     * transcribed by a model that can be wrong. A figure in here disagreeing with
     * the expense is a fact about the scan, not a discrepancy to reconcile.
     *
     * Absent on everything typed by hand, which is most expenses.
     */
    receipt: {
      type: new mongoose.Schema(
        {
          merchant: { type: String, default: null },
          /** The bill's own reference, and the seller's tax id, as printed. */
          invoiceNo: { type: String, default: null },
          gstin: { type: String, default: null },
          paymentMethod: { type: String, default: null },
          /** All integer minor units, like every other amount here. */
          subtotalMinor: { type: Number, default: null },
          /**
           * One entry per printed tax line, kept apart rather than summed: an
           * Indian bill prints CGST and SGST separately at half the rate each, and
           * a single "tax" figure loses the split a GST return needs.
           */
          taxes: {
            type: [
              {
                _id: false,
                label: { type: String, required: true },
                amountMinor: { type: Number, required: true },
                /** Null when the bill printed an amount but no percentage. */
                rate: { type: Number, default: null },
              },
            ],
            default: [],
          },
          serviceMinor: { type: Number, default: null },
          discountMinor: { type: Number, default: null },
          tipMinor: { type: Number, default: null },
          /** What the bill said it came to — not what these expenses add up to. */
          totalMinor: { type: Number, default: null },
          /**
           * The photo, named rather than positional.
           *
           * It is also in `attachments[0]`, and the duplication is deliberate:
           * `attachments` is a general list that could hold anything later, while
           * this says *which* image is the receipt for this expense. A consumer
           * asking "show me the receipt" should not have to know that index zero
           * happens to be it today.
           */
          imageUrl: { type: String, default: null },
          scannedAt: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
      default: null,
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
