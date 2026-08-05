const mongoose = require("mongoose");
const { LEDGER_ENTRY_TYPES, LEDGER_CATEGORIES, LIMITS, DEFAULT_CURRENCY } = require("../constants");

/**
 * A repayment against a loan.
 *
 * Embedded rather than its own collection because it is unconditionally read with
 * its parent, bounded in practice (a ₹1,000 loan is not repaid in a hundred
 * instalments), and never queried across entries. A separate collection would buy
 * a join and nothing else.
 */
const repaymentSchema = new mongoose.Schema(
  {
    amountMinor: {
      type: Number,
      required: true,
      min: [1, "A repayment must be greater than zero"],
      validate: {
        validator: Number.isInteger,
        message: "Money is stored in integer minor units — see docs/05-ALGORITHMS.md §1",
      },
    },
    paidAt: { type: Date, default: Date.now },
    note: { type: String, default: "", trim: true, maxlength: LIMITS.LEDGER_NOTE_MAX },
  },
  { _id: true, timestamps: false }
);

/**
 * One line in a personal ledger: money spent, lent, or borrowed.
 *
 * ## The counterparty is a name, never a member
 *
 * `counterpartyName` is free text on purpose. Storing a `memberId` would invite a
 * join between a personal loan and a group balance sheet — the exact operation
 * that breaks the settlement engine's zero-sum guarantee
 * (docs/08-PERSONAL-LEDGER.md §2). The person owed money may not use this app at
 * all, and is never notified: this is one person's record of what happened, not a
 * two-sided agreement.
 *
 * ## The principal is immutable under repayment
 *
 * `amountMinor` is what was lent. Repayments accumulate in `repayments[]` and the
 * outstanding balance is *derived* — never stored — for the same reason group
 * balances are: a stored total is a total that can drift from the rows it
 * summarises, and a reconciliation bug in a ledger about money is indefensible.
 */
const ledgerEntrySchema = new mongoose.Schema(
  {
    ledgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ledger",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(LEDGER_ENTRY_TYPES),
      required: true,
    },
    /** The principal. Never mutated by a repayment. */
    amountMinor: {
      type: Number,
      required: true,
      min: [1, "Amount must be greater than zero"],
      validate: {
        validator: Number.isInteger,
        message: "Money is stored in integer minor units — see docs/05-ALGORITHMS.md §1",
      },
    },
    currencyCode: { type: String, default: DEFAULT_CURRENCY, uppercase: true },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.LEDGER_DESC_MAX,
    },
    /** Free text, and deliberately not a member reference — see above. */
    counterpartyName: {
      type: String,
      default: "",
      trim: true,
      maxlength: LIMITS.LEDGER_COUNTERPARTY_MAX,
    },
    category: {
      type: String,
      enum: [...LEDGER_CATEGORIES, ""],
      default: "",
    },
    /** When the money moved, which is rarely when the row was created. */
    occurredAt: { type: Date, default: Date.now, index: true },
    /**
     * Optional, and only meaningful on a debt. Setting it is what opts the entry
     * into a reminder — rather than a separate switch nobody finds
     * (docs/08-PERSONAL-LEDGER.md §10).
     */
    dueAt: { type: Date, default: null },
    repayments: {
      type: [repaymentSchema],
      default: [],
      validate: {
        validator: (list) => list.length <= LIMITS.MAX_REPAYMENTS_PER_ENTRY,
        message: `At most ${LIMITS.MAX_REPAYMENTS_PER_ENTRY} repayments per entry`,
      },
    },
    /**
     * Set when the outstanding balance reaches zero, or closed by hand. Reopening
     * is done by removing a repayment, not by clearing this — so the flag can
     * never disagree with the rows beneath it.
     */
    settledAt: { type: Date, default: null },
    notes: { type: String, default: "", trim: true, maxlength: LIMITS.LEDGER_NOTE_MAX },
    /** Soft delete, as expenses are — a deleted entry stays auditable. */
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    /** Optimistic concurrency, matching the expense model. */
    version: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** The list view. */
ledgerEntrySchema.index({ ledgerId: 1, isDeleted: 1, occurredAt: -1, _id: -1 });
/** Outstanding debts, per type. */
ledgerEntrySchema.index({ ledgerId: 1, type: 1, settledAt: 1, isDeleted: 1 });
/** The reminder sweep — must find due entries without scanning every ledger. */
ledgerEntrySchema.index({ dueAt: 1, settledAt: 1, isDeleted: 1 });

/**
 * Guard the one invariant that cannot be recovered from: you cannot repay more
 * than was lent. Asserted at the schema as well as in the service, because this
 * is the last line before the data is wrong.
 */
ledgerEntrySchema.pre("save", async function guardRepayments() {
  const repaid = this.repayments.reduce((sum, r) => sum + r.amountMinor, 0);
  if (repaid > this.amountMinor) {
    throw new Error(`Repayment integrity violation: repaid ${repaid}, principal is ${this.amountMinor}`);
  }
});

module.exports = mongoose.model("LedgerEntry", ledgerEntrySchema);
