const mongoose = require("mongoose");

/**
 * How much of a metered feature a group has used this month
 * (docs/22-MONETIZATION.md §7).
 *
 * ## Per group, not per member
 *
 * Consistent with the entitlement it meters: one payment covers everyone, so one
 * allowance covers everyone. The alternative — an allowance per member — hands a
 * five-person group five times the free receipt scans of a two-person group, which
 * is a rule nobody could explain to either of them and an invitation to add four
 * imaginary flatmates.
 *
 * ## Why a bucket per month rather than a row per use
 *
 * The same argument as `aiUsage`: a row per use grows without bound to answer a
 * question nobody asks per-row, and every "how many left?" — which is every group
 * summary — becomes a scan. A month bucket is one atomic `$inc` per use, twelve
 * documents a year per feature per group, and the read is a point lookup.
 *
 * ## Why the period is a string
 *
 * `YYYY-MM` in UTC, so a bucket is addressable without a range query and the reset
 * boundary is the same instant for everyone. A group travelling through timezones
 * does not get a second allowance for flying east.
 */
const featureUsageSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
    },
    /** A value from `FEATURES` — the wire key, e.g. `receiptScan`. */
    feature: {
      type: String,
      required: true,
    },
    /** `YYYY-MM`, UTC. */
    period: {
      type: String,
      required: true,
    },
    used: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

/**
 * One bucket per group per feature per month. The conditional upsert in
 * entitlementService depends on this being unique: it is what turns a lost race
 * into a duplicate-key error — which is correctly read as "the allowance is gone" —
 * rather than into a second bucket that quietly doubles the allowance.
 */
featureUsageSchema.index({ groupId: 1, feature: 1, period: 1 }, { unique: true });

/**
 * Buckets delete themselves after roughly thirteen months.
 *
 * This is a meter, not a financial record: it exists to answer "how many are left
 * *this* month", and last March's answer has no reader. Thirteen months rather
 * than twelve so a year-on-year comparison is still possible while somebody is
 * looking at it.
 */
featureUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

module.exports = mongoose.model("FeatureUsage", featureUsageSchema);
