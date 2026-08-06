const mongoose = require("mongoose");

const PointEvent = require("../models/pointEvent");
const User = require("../models/user");
const {
  POINT_EVENT_TYPES,
  POINT_RULES,
  POINTS,
  ACTIVITY_TYPES,
} = require("../constants");
const logger = require("../utils/logger");

/**
 * Reward points (docs/11-REWARDS.md).
 *
 * ## Two rules this file exists to enforce
 *
 * 1. **Nothing is awarded per expense.** The daily rule is `ACTIVE_DAY` — one
 *    award however many rows are created — because paying per row is a standing
 *    incentive to create rows, and in a shared group that silently distorts what
 *    everyone else owes.
 * 2. **Nothing is awarded from a client request.** Every earn originates in a
 *    domain event the server already handles. There is no `POST /points/claim`,
 *    because it would be farmed within a day.
 *
 * Everything here is best effort: a points failure must never fail the expense,
 * settlement or sign-in that triggered it.
 */

/** `YYYY-MM-DD` in UTC. Day boundaries only decide *when* a rule resets. */
const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);

const keyFor = (userId, type, day, subject) => {
  const rule = POINT_RULES[type];
  if (!rule) return undefined;
  /**
   * Rules keyed on a *subject* — referrals. The bound is "once per person you
   * introduced", which is neither per-day nor once-ever: the same friend must
   * never pay twice, but a different friend always may.
   */
  if (rule.key === "subject") return subject ? `${userId}:${type}:${subject}` : undefined;
  // Once-ever rules key on the type alone; daily rules include the date.
  if (rule.once) return `${userId}:${type}`;
  if (rule.perDay === 1) return `${userId}:${type}:${day}`;
  // Repeatable-within-a-day rules are bounded by a count, not a key (below).
  return undefined;
};

/**
 * Positive points earned today from rules the daily ceiling governs.
 *
 * Two kinds are excluded, from the total as well as from the check. Once-ever
 * awards, because they are already bounded by being once-ever — a first-group
 * bonus should not eat into the day's allowance for ordinary earning. And rules
 * marked `uncapped`, currently the referral levels, which carry their own
 * tighter per-day limit for reasons the general cap was never designed to serve.
 */
const UNCAPPED_TYPES = Object.entries(POINT_RULES)
  .filter(([, rule]) => rule.once || rule.uncapped)
  .map(([type]) => type);

const earnedToday = async (userId, day) => {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(`${day}T23:59:59.999Z`);

  const [row] = await PointEvent.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(String(userId)),
        points: { $gt: 0 },
        type: { $nin: UNCAPPED_TYPES },
        createdAt: { $gte: start, $lte: end },
      },
    },
    { $group: { _id: null, total: { $sum: "$points" } } },
  ]);

  return row?.total || 0;
};

/** How many times a repeatable rule has already fired today. */
const countToday = async (userId, type, day) =>
  PointEvent.countDocuments({
    userId,
    type,
    createdAt: {
      $gte: new Date(`${day}T00:00:00.000Z`),
      $lte: new Date(`${day}T23:59:59.999Z`),
    },
  });

/**
 * Award points for a domain event.
 *
 * Returns the created row, or null when the rule did not fire — already earned
 * today, already earned ever, already earned for this subject, or the daily
 * ceiling is reached. Never throws.
 *
 * @param options.subject  for referral rules: the person whose action earned it,
 *                         so the same friend can never pay out twice
 */
const award = async (userId, type, metadata = {}, options = {}) => {
  try {
    if (!userId) return null;

    const rule = POINT_RULES[type];
    if (!rule) return null;

    const day = dayKey();
    const dedupeKey = keyFor(userId, type, day, options.subject);

    /**
     * A subject-keyed rule with no subject would fall through to an unkeyed
     * insert and lose its only dedupe — refuse rather than pay out unbounded.
     */
    if (rule.key === "subject" && !dedupeKey) return null;

    /**
     * Already earned — checked before attempting the write.
     *
     * The unique index is what actually guarantees this, and it stays the
     * guarantee: a race still ends in a duplicate-key error, caught below. This
     * is only to avoid *routinely* provoking one. Some of these hooks run on
     * every page load (enabling notifications) or several times a day (streak
     * milestones), and a failed insert per call is a write, a stack, and a wasted
     * round trip to reach a "no" an indexed read answers.
     */
    if (dedupeKey && (await PointEvent.exists({ dedupeKey }))) return null;

    /**
     * The ceiling, checked before the write — and it applies to **repeatable**
     * earning only.
     *
     * Once-ever awards are exempt because they are already bounded by being
     * once-ever: a streak milestone or a first-group bonus cannot be farmed
     * however many times it fires. Letting the daily cap swallow one would mean
     * someone loses the reward for a 30-day streak because they happened to
     * settle two debts the same afternoon — silently, with nothing to explain
     * it. The cap exists to bound the repeatable rules, and that is all it
     * should do. Referral levels are exempt for a different reason and carry
     * their own limit instead; see `UNCAPPED_TYPES`.
     */
    if (!rule.once && !rule.uncapped) {
      const already = await earnedToday(userId, day);
      if (already + rule.points > POINTS.DAILY_EARN_CAP) return null;
    }

    /**
     * The per-day count. For ordinary repeatable rules this is what bounds them
     * at all, since they have no dedupe key. For referral levels the key already
     * prevents double-paying one person — this is the separate limit on *how
     * many* people may pay out in a day, which is the rate a leak would drain at.
     */
    if (!rule.once && rule.perDay > 1) {
      const used = await countToday(userId, type, day);
      if (used >= rule.perDay) return null;
    }

    const event = await PointEvent.create({
      userId,
      type,
      points: rule.points,
      metadata,
      dedupeKey,
    });

    /**
     * A first day of real use is what pays somebody's referral — not the signup.
     * Fired from here, the one place every `ACTIVE_DAY` passes through, so a
     * future earning hook cannot forget it. Lazily required and unawaited: the
     * referral walk must not sit in front of the expense that triggered it, and
     * referralService reads this module back.
     */
    if (type === POINT_EVENT_TYPES.ACTIVE_DAY) {
      // eslint-disable-next-line global-require -- mutual dependency, see above
      require("./referralService").qualify(userId).catch(() => {});
    }

    return event;
  } catch (err) {
    /**
     * A duplicate key is the mechanism working, not a failure: two concurrent
     * writes raced for the same once-daily award and one lost. Anything else is
     * worth seeing.
     */
    if (err?.code !== 11000) {
      logger.warn(`[points] Could not award ${type}: ${err.message}`);
    }
    return null;
  }
};

/**
 * Spend points. Returns true only if the balance covered it.
 *
 * Reads the balance and then writes, which is a race in principle — two
 * simultaneous questions could each see the same balance. It is bounded and
 * deliberate: the worst case is one question's worth of overdraft, and the
 * alternative (a transaction, or a mutable counter) costs either a replica-set
 * dependency or the derived-balance guarantee that makes this ledger auditable.
 */
const spend = async (userId, type, cost, metadata = {}) => {
  try {
    if (!userId || cost <= 0) return false;

    const balance = await getBalance(userId);
    if (balance < cost) return false;

    await PointEvent.create({ userId, type, points: -cost, metadata });
    return true;
  } catch (err) {
    logger.warn(`[points] Could not spend ${cost} for ${type}: ${err.message}`);
    return false;
  }
};

/** `Σ points`. Derived on every read — there is no stored balance to drift. */
const getBalance = async (userId) => {
  const [row] = await PointEvent.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
    { $group: { _id: null, total: { $sum: "$points" } } },
  ]);
  return row?.total || 0;
};

/**
 * Consecutive days with an `ACTIVE_DAY` award, counting back from today.
 *
 * Read from the event log rather than kept as a counter, so it cannot disagree
 * with the history. Bounded to the longest milestone — nobody needs to know
 * about day 400 to award day 30.
 */
const currentStreak = async (userId) => {
  const longest = Math.max(...POINTS.STREAK_MILESTONES.map((m) => m.days));

  const rows = await PointEvent.find({ userId, type: POINT_EVENT_TYPES.ACTIVE_DAY })
    .sort({ createdAt: -1 })
    .limit(longest + 1)
    .select("createdAt")
    .lean();

  const days = new Set(rows.map((row) => dayKey(row.createdAt)));

  let streak = 0;
  const cursor = new Date();
  // Today may not have been earned yet; start from today and walk back.
  for (let i = 0; i <= longest; i += 1) {
    if (!days.has(dayKey(cursor))) break;
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return streak;
};

/** Award any streak milestone the current run has just reached. */
const awardStreakMilestones = async (userId) => {
  const streak = await currentStreak(userId);
  const reached = POINTS.STREAK_MILESTONES.filter((m) => streak >= m.days);
  // Once-ever dedupe keys make re-awarding a no-op, so this can be unconditional.
  await Promise.all(reached.map((m) => award(userId, m.type, { streak })));
  return streak;
};

/**
 * The account behind a group member, via the device link recorded at sign-in.
 *
 * Group activity is device-scoped and points are account-scoped, so this is the
 * bridge — the same one the AI context uses, and read-only for the same reason:
 * a device proves a browser was used, never who used it.
 */
const userIdForMember = async (actor) => {
  const deviceIds = (actor?.deviceIds || []).filter(Boolean);
  if (actor?.deviceId) deviceIds.push(actor.deviceId);
  if (deviceIds.length === 0) return null;

  const user = await User.findOne({ deviceIds: { $in: deviceIds } }).select("_id").lean();
  return user?._id || null;
};

/** Which activity types earn, and what they earn. */
const ACTIVITY_AWARDS = {
  [ACTIVITY_TYPES.EXPENSE_ADDED]: POINT_EVENT_TYPES.ACTIVE_DAY,
  [ACTIVITY_TYPES.SETTLEMENT_RECORDED]: POINT_EVENT_TYPES.SETTLEMENT,
  [ACTIVITY_TYPES.GROUP_CREATED]: POINT_EVENT_TYPES.FIRST_GROUP,
};

/**
 * Points for a group event. Called from the activity funnel, never awaited.
 *
 * Note `EXPENSE_ADDED` maps to `ACTIVE_DAY`: adding a tenth expense today earns
 * nothing more than the first did. That is the design (§2), not an oversight.
 */
const awardForActivity = async (activity, actor) => {
  try {
    const type = ACTIVITY_AWARDS[activity?.type];
    if (!type) return null;

    const userId = await userIdForMember(actor);
    if (!userId) return null; // Not signed in on this device — nothing to credit.

    const result = await award(userId, type, {
      activityType: activity.type,
      groupId: String(activity.groupId),
    });

    // A day that earned is a day that counts toward a streak.
    if (result && type === POINT_EVENT_TYPES.ACTIVE_DAY) await awardStreakMilestones(userId);

    return result;
  } catch (err) {
    logger.warn(`[points] Activity award failed: ${err.message}`);
    return null;
  }
};

/**
 * The one-off award for turning notifications on.
 *
 * Push registration is device-scoped and unauthenticated — it has to be, since
 * groups work signed out — so the account is found the same way group activity
 * finds it. No account on this device simply means nothing to credit.
 *
 * Called on every token refresh, not only the first: the client re-registers on
 * each load, and there is no "first time" signal to hang this on. The once-ever
 * dedupe key makes the repeats a cheap indexed read (see `award`).
 */
const awardNotificationsEnabled = async (deviceId) => {
  try {
    const userId = await userIdForMember({ deviceId });
    if (!userId) return null;
    return await award(userId, POINT_EVENT_TYPES.NOTIFICATIONS_ENABLED, {});
  } catch (err) {
    logger.warn(`[points] Notification award failed: ${err.message}`);
    return null;
  }
};

/** Recent movements, for the points sheet. */
const recentEvents = (userId, limit = 20) =>
  PointEvent.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("type points metadata createdAt")
    .lean();

module.exports = {
  award,
  spend,
  getBalance,
  currentStreak,
  awardStreakMilestones,
  awardForActivity,
  awardNotificationsEnabled,
  recentEvents,
  userIdForMember,
  dayKey,
};
