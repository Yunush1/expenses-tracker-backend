const Entitlement = require("../models/entitlement");
const FeatureUsage = require("../models/featureUsage");

/** All entitlement and meter queries live here. The rules belong to the service. */

const findByGroup = (groupId) => Entitlement.findOne({ groupId });

/**
 * Create or replace a group's grant.
 *
 * Upsert rather than insert because a group has at most one entitlement — a second
 * one would be a second answer to "what is this group on", and the unique index
 * would refuse it anyway.
 */
const upsert = (groupId, fields) =>
  Entitlement.findOneAndUpdate(
    { groupId },
    { $set: { groupId, ...fields } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

/**
 * End a grant now, without deleting it.
 *
 * The row survives because it is what a refund or a billing question is answered
 * from later, and because an expiry in the past is already the one downgrade path
 * the resolver understands — see models/entitlement.js.
 */
const expireNow = (groupId, note) =>
  Entitlement.findOneAndUpdate(
    { groupId },
    { $set: { expiresAt: new Date(), ...(note ? { note } : {}) } },
    { new: true }
  );

/** This month's counters for one group, as `{ [feature]: used }`. */
const usageForPeriod = async (groupId, period) => {
  const buckets = await FeatureUsage.find({ groupId, period }).select("feature used").lean();

  return buckets.reduce((usage, bucket) => {
    usage[bucket.feature] = bucket.used || 0;
    return usage;
  }, {});
};

/**
 * Claim one use of a metered feature, but only if the allowance has room.
 *
 * The filter carries `used: { $lt: allowance }`, which makes the check and the
 * increment one atomic operation instead of a read followed by a write that two
 * requests can interleave. That matters here more than in most places: the thing
 * being protected is a metered call to a paid provider, and the classic
 * check-then-increment race spends real money for free.
 *
 * Returns `true` when the use was claimed, `false` when the allowance is gone.
 *
 * The upsert has one sharp edge worth naming. When a bucket already exists and is
 * at its limit, the filter matches nothing, so Mongo attempts an insert and the
 * unique index rejects it with E11000 — which is not a failure but the answer:
 * there is a bucket, and it is full. Any other error is a real one and is rethrown.
 */
const tryConsume = async (groupId, feature, period, allowance, count = 1) => {
  /**
   * An allowance too small to cover this use is refused before Mongo sees it.
   *
   * Not a shortcut — it is the one case the upsert gets wrong. With `allowance: 0`
   * the filter becomes `used: { $lte: -1 }`, which matches nothing, so a group with
   * no bucket yet would fall through to the insert and be granted the use it was
   * just told it could not have.
   */
  if (allowance - count < 0) return false;

  try {
    const result = await FeatureUsage.updateOne(
      { groupId, feature, period, used: { $lte: allowance - count } },
      { $inc: { used: count } },
      { upsert: true }
    );

    return result.modifiedCount > 0 || result.upsertedCount > 0;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
};

/** Hand a use back — for a metered call that was claimed and then failed. */
const refund = (groupId, feature, period, count = 1) =>
  FeatureUsage.updateOne(
    { groupId, feature, period, used: { $gte: count } },
    { $inc: { used: -count } }
  );

module.exports = {
  findByGroup,
  upsert,
  expireNow,
  usageForPeriod,
  tryConsume,
  refund,
};
