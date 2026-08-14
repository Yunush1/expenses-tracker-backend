const mongoose = require("mongoose");
const { SPLIT_TYPES, LIMITS, DEFAULT_CURRENCY, RECURRENCE } = require("../constants");

/**
 * An expense template with a schedule — rent on the 1st, wifi on the 5th, the
 * maid, the milk, Netflix (docs/16-TODO.md §2.2).
 *
 * ## What this converts the product into
 *
 * A group that exists for a Goa trip ends when the trip does. A group with rent in
 * it is a standing arrangement people live inside, and flatshares are already the
 * longest-lived groups here — this is what gives those months something to
 * contain. Until now "recurring" appeared only in Ria's system prompt: she could
 * discuss it, the app could not do it.
 *
 * ## Why the template is not an expense
 *
 * It has no `shares` and no amount that has been *spent*. It describes an expense
 * that will exist, and every month it produces one real `Expense` through the
 * ordinary service — so activity, push and the personal-ledger mirror all fire
 * exactly as they do for something typed by hand, with no second code path to keep
 * in step.
 *
 * The consequence worth stating: **deleting a template never touches the expenses
 * it created.** Those are the group's financial record. Somebody removing "rent"
 * because they moved out is saying "stop making these", not "the last eight months
 * of rent did not happen".
 *
 * ## Why participants are ids and not shares
 *
 * A share is money, and the money is decided when the expense is materialised — by
 * the same `splitCalculator` every other expense goes through. Storing computed
 * shares here would freeze a split that has to be recomputed anyway (the amount can
 * be edited, a participant can leave), and would put a second, staler copy of the
 * split arithmetic in the codebase.
 */
const recurringExpenseSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      index: true,
    },

    /* ------------------------- The expense to make ------------------------ */

    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.EXPENSE_DESC_MAX,
    },
    /** Integer minor units, like every other amount here — docs/05-ALGORITHMS.md §1. */
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
    participantIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Member" }],
      required: true,
      validate: {
        validator: (ids) => ids.length > 0,
        message: "A recurring expense needs at least one participant",
      },
    },
    splitType: {
      type: String,
      enum: Object.values(SPLIT_TYPES),
      default: SPLIT_TYPES.EQUAL,
    },
    /** The per-participant input, in the unit its split type uses. Empty for EQUAL. */
    splitValues: {
      type: [
        {
          _id: false,
          memberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
          value: { type: Number, required: true },
        },
      ],
      default: [],
    },
    category: {
      type: String,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: LIMITS.EXPENSE_NOTES_MAX,
      default: "",
    },

    /* ---------------------------- The schedule ---------------------------- */

    frequency: {
      type: String,
      enum: Object.values(RECURRENCE),
      default: RECURRENCE.MONTHLY,
    },
    /**
     * Which day of the month a MONTHLY template fires on, 1–31.
     *
     * A rent set for the 31st runs on the 30th in April and the 28th in February —
     * clamped, never skipped. Skipping would mean a flatshare silently missing a
     * month's rent, which is the single most expensive thing this feature could get
     * wrong, and "the 31st" plainly means "the end of the month" to whoever typed it.
     */
    dayOfMonth: {
      type: Number,
      min: 1,
      max: 31,
      default: 1,
    },
    /** 0 = Sunday … 6 = Saturday, for WEEKLY templates. Ignored otherwise. */
    weekday: {
      type: Number,
      min: 0,
      max: 6,
      default: 1,
    },
    /**
     * The next date this should produce an expense for — a **date**, at UTC
     * midnight, not an instant.
     *
     * This is the whole idempotency story, together with `clientRequestId`. It is
     * advanced only after an expense for that date exists, so a job that dies
     * halfway, a server restart, or two instances ticking at once all converge on
     * one expense per due date rather than two.
     */
    nextRunAt: {
      type: Date,
      required: true,
      index: true,
    },
    lastRunAt: {
      type: Date,
      default: null,
    },
    /**
     * How many expenses this template has produced. Display only — it tells someone
     * looking at "Rent" that it has fired eight times, which is the question they
     * have before deleting it.
     */
    runCount: {
      type: Number,
      default: 0,
    },
    /**
     * Due dates that passed without producing an expense, because the group's plan
     * did not stretch to this template at the time.
     *
     * Counted rather than silently dropped, because the alternative is a flatshare
     * discovering in March that January's rent was never added and nothing
     * anywhere says why. The UI reads these to explain it.
     *
     * Note what this does *not* do: it never materialises the gap later. When a
     * group's plan comes back, the template resumes from the next due date — a
     * resubscription that retroactively posted six months of rent into a live
     * group would move everybody's balance for a decision one person made about a
     * subscription.
     */
    skippedCount: {
      type: Number,
      default: 0,
    },
    lastSkippedAt: {
      type: Date,
      default: null,
    },
    /**
     * Stopped by a person, deliberately.
     *
     * Distinct from stopping because the group's plan no longer covers it, which is
     * not stored anywhere: a template over the plan's cap simply is not selected
     * when the job runs, and starts again by itself the moment the group is
     * entitled again. Writing that into the row would mean a downgrade *edited*
     * somebody's templates, and resubscribing would have to guess which ones to
     * un-edit (docs/22-MONETIZATION.md §6).
     */
    isPaused: {
      type: Boolean,
      default: false,
    },
    /**
     * When to stop entirely. Null means it runs until somebody says otherwise,
     * which is what "rent" means.
     */
    endsOn: {
      type: Date,
      default: null,
    },
    createdByMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

/**
 * The job's only query: everything due, across every group.
 *
 * Compound and ordered so the index alone answers it — `isDeleted` and `isPaused`
 * narrow to the live templates, and `nextRunAt` is the range. Without this the
 * scheduler would scan every template in the database every fifteen minutes.
 */
recurringExpenseSchema.index({ isDeleted: 1, isPaused: 1, nextRunAt: 1 });

/** Listing a group's templates, oldest first — which is also the plan's cap order. */
recurringExpenseSchema.index({ groupId: 1, isDeleted: 1, createdAt: 1 });

module.exports = mongoose.model("RecurringExpense", recurringExpenseSchema);
