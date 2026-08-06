const mongoose = require("mongoose");
const { POINT_EVENT_TYPES } = require("../constants");

/**
 * One movement in a person's points balance (docs/11-REWARDS.md §5).
 *
 * ## Append-only, and the balance is derived
 *
 * There is no `balance` column anywhere. `balance = Σ points`, computed on read,
 * for the same reason group balances and ledger outstandings are derived: **a
 * stored total can drift from the rows that produced it**, and a rewards balance
 * that disagrees with its own history is indistinguishable from a bug — and
 * reads, to the person it belongs to, as theft.
 *
 * Rows are never updated or deleted. Spending is a negative row, not a decrement.
 */
const pointEventSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(POINT_EVENT_TYPES),
      required: true,
    },
    /** Signed: earning is positive, spending negative. Always a whole number. */
    points: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: "Points are whole numbers",
      },
    },
    /** What caused it — the group, the entry, the question. For auditing only. */
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    /**
     * The idempotency key, and the thing that makes once-daily rules honest.
     *
     * `userId:type:2026-08-06` for a daily rule, `userId:type` for a once-ever
     * one. A unique index means two concurrent expense creations cannot both
     * award the day's ten points — the second insert fails and is ignored.
     * Checking "have they earned today?" and then writing has a race a
     * determined user will find, and this feature is precisely the one people
     * try to cheat.
     *
     * Sparse: repeatable events (a second settlement today) carry no key.
     */
    dedupeKey: {
      type: String,
      default: undefined,
    },
  },
  { timestamps: true }
);

pointEventSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
/** The balance sum and the recent-events list. */
pointEventSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("PointEvent", pointEventSchema);
