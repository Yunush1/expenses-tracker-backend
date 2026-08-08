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
    /**
     * How many reminders this entry has already produced, and on which local date
     * the last one went out.
     *
     * Two, ever: one on the due date and one follow-up a week later. The app's job
     * is to remind, not to chase on someone's behalf — a ledger that pesters daily
     * gets its notifications blocked, and that costs the expense alerts too
     * (docs/07-NOTIFICATIONS.md §9). The date is the owner's local one, stored as
     * a string, so "already reminded today" is answerable without repeating
     * timezone maths at every read.
     */
    reminderCount: { type: Number, default: 0 },
    lastRemindedOn: { type: String, default: "" },
    /**
     * Where this row came from: typed by hand, or mirrored from a group expense.
     *
     * A mirrored entry is **this person's share** of a shared bill, not its total
     * — if I pay ₹1,000 for a dinner split four ways, ₹250 is what I actually
     * spent and ₹750 is money owed back to me, which the group already tracks.
     * Storing the total here would inflate their personal spending by whatever
     * they happen to have fronted (docs/08-PERSONAL-LEDGER.md §12).
     *
     * The distinction is kept rather than merged because these rows are not fully
     * the owner's to edit: they follow the group expense, and they must be
     * identifiable so a total that also counts the group is not double-counted.
     */
    source: {
      type: String,
      enum: ["MANUAL", "GROUP_EXPENSE"],
      default: "MANUAL",
    },
    /**
     * The expense this mirrors. No `default: null` — a sparse index skips missing
     * fields, not null ones, so a default would make every manual entry collide
     * on the uniqueness guarantee below. (Learned the hard way; see
     * docs/12-REFERRALS.md §6.)
     */
    sourceExpenseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Expense",
    },
    sourceGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
    },
    /**
     * Which member of that group the owner was.
     *
     * Needed because an edit can change someone's share without changing the
     * expense total — adding a fourth person to a ₹1,000 bill moves a share from
     * ₹333 to ₹250 — so keeping the mirror in step means recomputing *this
     * member's* share, which requires knowing which member that was. It cannot be
     * re-derived later: a member can be renamed, removed, or have their devices
     * change hands.
     */
    sourceMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
    },
    /** Shown on the entry, so a row nobody typed is never a mystery. */
    sourceGroupName: { type: String, default: "", trim: true, maxlength: LIMITS.GROUP_NAME_MAX },
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
 * One mirror per expense, per ledger — enforced by the database rather than by a
 * check-then-write in the service.
 *
 * The mirror is written from a fire-and-forget hook on an endpoint clients retry,
 * so "did we already mirror this?" is a question two requests can ask at the same
 * time and both answer no. The index makes the loser of that race an error to
 * swallow instead of a duplicate row in someone's private ledger.
 *
 * ## Partial, not sparse — and this was a real bug
 *
 * `sparse: true` does not do what it reads like on a **compound** index. Mongo
 * skips a document only when it is missing *every* indexed field; a manually
 * typed entry has a `ledgerId` and no `sourceExpenseId`, so it is indexed with
 * `sourceExpenseId: null` and collides with every other manual entry in the same
 * ledger. The build therefore fails with E11000 on `{ ledgerId, null }` the
 * moment a user has two hand-written rows — which means **this index has never
 * existed in a database that has any**, and the uniqueness the comment above
 * promises has never actually been enforced.
 *
 * The partial filter indexes only rows that carry a real expense id, which is
 * exactly the set the guarantee is about. Manual entries are excluded outright
 * instead of colliding on a shared null.
 */
ledgerEntrySchema.index(
  { ledgerId: 1, sourceExpenseId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceExpenseId: { $type: "objectId" } },
  }
);

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
