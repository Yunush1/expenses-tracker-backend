const mongoose = require("mongoose");
const { DUE_REQUEST_KINDS, DUE_REQUEST_STATUS, LIMITS } = require("../constants");

/**
 * One member asking another about a previous-month due
 * (docs/29-BALANCE-CYCLES.md §7).
 *
 * ## This is the social layer, not the money
 *
 * Nothing here is read by a balance or a due. What is owed is always derived from
 * expenses and settlements; a request only records that somebody *asked*. That is
 * why `amountMinor` is a snapshot — "you asked for ₹1,300 on the 3rd" — and the
 * live figure is recomputed every time the request is shown. If the two differ,
 * the screen shows both rather than pretending the request said something it
 * did not.
 *
 * ## Debtor and creditor are fixed; who asked is separate
 *
 * `fromMemberId` always owes `toMemberId`, whoever sent the request. A PAYMENT is
 * always sent by the creditor. A MERGE may come from either side, and must be
 * answered by the *other* one — `respondentMemberId` says who that is, so the
 * check is one comparison rather than a rule re-derived at every call site.
 */
const dueRequestSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      index: true,
    },
    kind: {
      type: String,
      enum: Object.values(DUE_REQUEST_KINDS),
      required: true,
    },
    /** The debtor. */
    fromMemberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
    /** The creditor. */
    toMemberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
    requestedByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
    respondentMemberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
    /** What was asked for, when it was asked. Never re-read as the amount owed. */
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: "Amount must be integer minor units" },
    },
    /** The months that made up `amountMinor`, oldest first, as they stood then. */
    breakdown: {
      type: [
        new mongoose.Schema(
          { periodKey: { type: String, required: true }, amountMinor: { type: Number, required: true } },
          { _id: false }
        ),
      ],
      default: [],
    },
    /**
     * MERGE only: the month the due moves into — the current month when it was
     * asked. Once that month is no longer current the request has expired: an
     * acceptance then would move money into a month nobody agreed to.
     */
    targetPeriodKey: { type: String, default: null },
    note: { type: String, trim: true, maxlength: LIMITS.SETTLEMENT_NOTE_MAX, default: "" },
    status: {
      type: String,
      enum: Object.values(DUE_REQUEST_STATUS),
      default: DUE_REQUEST_STATUS.PENDING,
    },
    respondedAt: { type: Date, default: null },
    /** The CARRY_FORWARD pair an accepted MERGE wrote. */
    pairId: { type: String, default: null },
  },
  { timestamps: true }
);

dueRequestSchema.index({ groupId: 1, status: 1, createdAt: -1 });
/**
 * One open request of each kind per pair, enforced by the database.
 *
 * "Ask A4 to merge" is a button two devices can press at the same moment, and a
 * check-then-insert in the service answers "is there one already?" with no for
 * both of them. Partial, so a pair's decided requests — any number of them — do
 * not collide with each other or with the next open one.
 */
dueRequestSchema.index(
  { groupId: 1, kind: 1, fromMemberId: 1, toMemberId: 1 },
  { unique: true, partialFilterExpression: { status: DUE_REQUEST_STATUS.PENDING } }
);

module.exports = mongoose.model("DueRequest", dueRequestSchema);
