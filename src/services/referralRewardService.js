const Member = require("../models/member");
const Group = require("../models/group");
const expenseRepository = require("../repositories/expenseRepository");
const entitlementService = require("./entitlementService");
const config = require("../config/env");
const { GROUP_STATUS, PLANS, GRANT_SOURCES } = require("../constants");
const logger = require("../utils/logger");

/**
 * A qualified referral, paid in days of Group Pro
 * (docs/22-MONETIZATION.md §11, docs/12-REFERRALS.md).
 *
 * ## A second payout, not a second system
 *
 * Referrals already work: invite links, a multi-level points split, and the guards
 * that stop it being farmed. Nothing about *when* a referral qualifies changes
 * here — that is still "the invited person used the app", latched once per invited
 * account in `referralService.qualify`. This adds one more thing that happens at
 * that moment.
 *
 * ## Which group gets it, and why the choice is a guard
 *
 * §11 says the reward must attach to "a group with real activity, or the farm is
 * obvious: create a group, invite yourself, collect". So the group has to be
 * **activated** in §12's sense — two or more members have each paid for something
 * — which is a fact one person cannot manufacture alone in an afternoon.
 *
 * Among those, the most recently active wins. Not the largest, not the oldest: the
 * one somebody is living in this week is the one where thirty days of features is
 * worth having, and a dormant group quietly collecting plans is the outcome that
 * makes the whole payout feel arbitrary.
 *
 * **No qualifying group means no payout, and that is correct.** The points half is
 * already paid; this half is a bonus attached to a place to spend it. Granting a
 * plan to a group of one to avoid an empty-handed moment would reopen exactly the
 * farm §11 names.
 *
 * ## Why level one only
 *
 * Points pay the whole upline, split by percentage — that is what a divisible
 * currency is for. Days are chunky and non-divisible in any way a person would
 * accept: "you earned 10% of a month" is not a sentence, and rounding it produces
 * a second economy with its own drift. The person who actually made the invite
 * gets the days; everybody above them gets points, as they already did.
 */

/** Days one qualified referral is worth. Zero switches the payout off entirely. */
const daysPerReferral = () => Math.max(0, Number(config.entitlement.referralGrantDays) || 0);

/**
 * The best group to reward this account with, or null.
 *
 * Deliberately reads groups through *members*, the same way `expenseDraft`
 * resolves what somebody can write to: a user is bound to groups by the devices
 * they have used, and there is no direct user→group edge in this schema — which is
 * the no-account design working as intended rather than a missing index.
 */
const rewardableGroup = async (user) => {
  const deviceIds = (user.deviceIds || []).filter(Boolean);
  if (deviceIds.length === 0) return null;

  const memberships = await Member.find({ deviceIds: { $in: deviceIds }, isActive: true })
    .select("groupId")
    .lean();

  if (memberships.length === 0) return null;

  const groupIds = [...new Set(memberships.map((member) => String(member.groupId)))];

  /**
   * Bounded before the aggregation, not after. Somebody in two hundred groups is
   * either a heavy user or the thing this guard exists for, and either way the
   * twenty most recent are where a reward belongs.
   */
  const candidates = await Group.find({
    _id: { $in: groupIds },
    status: GROUP_STATUS.ACTIVE,
  })
    .select("_id name currency lastActivityAt")
    .sort({ lastActivityAt: -1 })
    .limit(20)
    .lean();

  if (candidates.length === 0) return null;

  const activated = new Set(
    await expenseRepository.activatedGroupIds(candidates.map((group) => group._id))
  );

  // `candidates` is already newest-first, so the first activated one is the most
  // recently active — no second sort, and no tie to break.
  return candidates.find((group) => activated.has(String(group._id))) || null;
};

/**
 * Pay one qualified referral in plan days.
 *
 * Best effort throughout, and never allowed to throw: this runs inside
 * `referralService.qualify`, which itself runs as a side effect of somebody
 * logging their first expense. A failure to hand out a bonus must not fail the
 * expense that triggered it — the same rule the points award already follows.
 *
 * Returns what was granted, or null, so the caller can log it.
 */
const grantForReferral = async (referrer, { referredUserId } = {}) => {
  const days = daysPerReferral();
  if (days === 0 || !referrer) return null;

  try {
    const group = await rewardableGroup(referrer);

    if (!group) {
      // Worth logging at info: "my friend joined and I got nothing" is a support
      // question, and this line is the answer to it.
      logger.info(
        `[referral] No activated group to reward user ${referrer._id} — points paid, no plan days`
      );
      return null;
    }

    const entitlement = await entitlementService.grant({
      group,
      plan: PLANS.GROUP_PRO,
      days,
      source: GRANT_SOURCES.REFERRAL,
      note: referredUserId ? `Referral reward (invited ${referredUserId})` : "Referral reward",
    });

    logger.info(
      `[referral] Granted ${days} days of Group Pro to "${group.name}" for user ${referrer._id}`
    );

    return {
      groupId: String(group._id),
      groupName: group.name,
      days,
      expiresAt: entitlement.expiresAt,
    };
  } catch (error) {
    logger.warn(`[referral] Could not grant plan days: ${error.message}`);
    return null;
  }
};

module.exports = { grantForReferral, rewardableGroup, daysPerReferral };
