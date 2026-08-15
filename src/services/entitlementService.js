const config = require("../config/env");
const entitlementRepository = require("../repositories/entitlementRepository");
const policy = require("../utils/entitlementPolicy");
const {
  PLANS,
  PLAN_STATUS,
  FEATURES,
  FEATURE_KINDS,
  FEATURE_SPECS,
  GRANT_SOURCES,
  ERROR_CODES,
} = require("../constants");
const { ForbiddenError, BadRequestError } = require("../errors");
const logger = require("../utils/logger");

/**
 * The entitlement layer (docs/22-MONETIZATION.md §6).
 *
 * Three jobs, and the order they are listed in is the order of importance:
 *
 * 1. **Answer what a group may do**, for the group payload the client draws from.
 * 2. **Refuse what it may not**, at the point of use — because a `features` block
 *    is for drawing the UI and nothing else. A client that has been told
 *    `receiptScan: false` and posts a receipt anyway is stopped here, not by a
 *    disabled button.
 * 3. **Issue grants**, by hand or by referral. No payment provider is involved and
 *    none is needed: a plan model with no checkout is still how a trial, a promo
 *    and a referral payout are expressed (§10).
 *
 * ## What this deliberately cannot do
 *
 * Take anything away from the free product. Downgrading never deletes an expense,
 * a share or a settlement — those are the group's financial record, not a feature
 * of a plan — and nothing here can gate adding an expense, splitting it, reading
 * balances or settling up, because none of them is in `FEATURES` at all.
 */

/** `YYYY-MM`, UTC — the same key shape and the same reasoning as aiUsageService. */
const periodKey = (date = new Date()) => date.toISOString().slice(0, 7);

/**
 * Everything known about a group's plan right now.
 *
 * Two point lookups, both indexed, and they are independent — so they go in
 * parallel. This runs on every group summary, which is the app's most-loaded
 * endpoint, and a plan that costs a serial round trip to read would be a tax on
 * every screen for a boolean most groups will never flip.
 */
const forGroup = async (groupId, now = new Date()) => {
  const period = periodKey(now);

  const [row, usage] = await Promise.all([
    entitlementRepository.findByGroup(groupId),
    entitlementRepository.usageForPeriod(groupId, period),
  ]);

  return { ...policy.snapshot(row, usage, now), period, usage, row };
};

/**
 * The context a refusal carries back, so the wall can be drawn from it (§8).
 *
 * Whatever goes in here is disclosed to a caller who has just been refused, so it
 * is kept to what the next step needs: which feature, what plan the group is on,
 * how much was used, and when it comes back. No prices — those belong to the
 * upgrade screen, from a pricing endpoint, so a stale cache cannot quote a figure
 * that has changed (§6).
 */
const refusalDetails = (feature, snapshot, group) => ({
  feature,
  plan: snapshot.plan,
  groupName: group?.name || null,
  limit: policy.allowanceFor(snapshot.plan, feature),
  used: snapshot.usage?.[feature] ?? 0,
  resetsOn: snapshot.limits.resetsOn,
});

/**
 * Refuse if this group may not use this feature.
 *
 * Two codes, not one, because the sentence a person needs to read differs and so
 * does what they should do about it. `FEATURE_LOCKED` means the plan does not
 * include it; `FEATURE_LIMIT_REACHED` means it does and this month's allowance is
 * spent. Collapsing them produces the wall that tells a paying customer to
 * upgrade — the single most expensive thing a paywall can say.
 *
 * The message says what was used and what is offered, and always leaves the door
 * open: running out of receipt scans must never stop an expense being added by
 * hand. The wall is around the shortcut, never around the ledger.
 */
/**
 * What still works when a feature runs out, per feature.
 *
 * §8's first rule is that a wall must never block the core — so a refusal names
 * the thing the person can still do. That sentence is different for each feature
 * and is the easiest part to get wrong: telling somebody who ran out of *exports*
 * that "adding it by hand always works" is nonsense, and nonsense at the exact
 * moment they are deciding whether this product is worth paying for.
 *
 * Absent means there is no alternative worth naming, and the message simply does
 * not claim one.
 */
const STILL_WORKS = Object.freeze({
  [FEATURES.RECEIPT_SCAN]: "Adding the expense by hand works as always",
  [FEATURES.EXPORT]: "Every expense is still here to read and search",
  [FEATURES.RECURRING_EXPENSES]: "Adding these by hand each month works as always",
  [FEATURES.CATEGORY_ANALYTICS]: "This month is always free to look at",
});

const assertAllowed = (snapshot, feature, group = null) => {
  if (policy.canUse(snapshot.plan, feature, snapshot.usage || {})) return;

  const spec = FEATURE_SPECS[feature];
  const inPlan = Boolean(policy.allowanceFor(snapshot.plan, feature));
  const metered = spec?.kind === FEATURE_KINDS.METERED;
  const groupName = group?.name ? ` for ${group.name}` : "";

  const error =
    metered && inPlan
      ? new ForbiddenError(
        [
          `That's the last one${groupName} this month.`,
          STILL_WORKS[feature],
          "Upgrading the group covers everyone in it.",
        ]
          .filter(Boolean)
          .join(" "),
        ERROR_CODES.FEATURE_LIMIT_REACHED
      )
      : new ForbiddenError(
        `This isn't included in ${groupName ? `${group.name}'s` : "this group's"} current plan. ` +
        "Upgrading covers everyone in the group.",
        ERROR_CODES.FEATURE_LOCKED
      );

  error.details = refusalDetails(feature, snapshot, group);
  throw error;
};

/**
 * Refuse a request that reaches further back than the plan allows.
 *
 * Distinct from `assertAllowed` because the feature is *not* locked: a free group
 * gets category analytics for the current month, and it is only the older months
 * that are behind a plan. Refusing the whole feature would be a lie, and silently
 * clamping the range to what is allowed would be worse — a breakdown labelled
 * "since January" that only covers August is a wrong answer presented confidently.
 *
 * The refusal carries `earliest`, so the client can say which months it can show.
 */
const assertWithinDepth = (snapshot, feature, from, group = null) => {
  if (policy.withinDepth(snapshot.plan, feature, from)) return;

  const floor = policy.depthFloor(snapshot.plan, feature);
  const months = policy.allowanceFor(snapshot.plan, feature);

  const error = new ForbiddenError(
    months === 1
      ? "This month is free to look at. Older months are part of the group's plan — upgrading covers everyone in it."
      : `The last ${months} months are free to look at. Going further back is part of the group's plan.`,
    ERROR_CODES.FEATURE_LOCKED
  );

  error.details = { ...refusalDetails(feature, snapshot, group), earliest: floor };
  throw error;
};

/**
 * Refuse when a group already holds as many of something as its plan allows.
 *
 * The counting is the caller's — this only knows the ceiling. Unlike a metered
 * allowance there is no meter and no monthly reset: a capacity limit is about how
 * many things exist right now, so deleting one makes room immediately.
 */
const assertCapacity = (snapshot, feature, current, group = null) => {
  const limit = policy.allowanceFor(snapshot.plan, feature);
  if (current < limit) return;

  const error = new ForbiddenError(
    limit === 0
      ? "This isn't included in the group's current plan. Upgrading covers everyone in the group."
      : `That's the ${limit === 1 ? "one" : limit} this group's plan allows. Remove one to add another, ` +
      "or upgrade the group — it covers everyone in it.",
    limit === 0 ? ERROR_CODES.FEATURE_LOCKED : ERROR_CODES.FEATURE_LIMIT_REACHED
  );

  error.details = { ...refusalDetails(feature, snapshot, group), limit, used: current };
  throw error;
};

/**
 * Claim one use of a metered feature, or refuse.
 *
 * Check and increment are a single atomic operation in the repository, so two
 * concurrent receipts cannot both see "one left". The `assertAllowed` above it is
 * not redundant: it is what produces the *explained* refusal, where the atomic
 * claim on its own can only say yes or no.
 *
 * Returns the snapshot as it stands **after** the claim, so a caller can tell the
 * user what is left without a second read.
 */
const consume = async (group, feature, count = 1, now = new Date()) => {
  const spec = FEATURE_SPECS[feature];

  if (spec?.kind !== FEATURE_KINDS.METERED) {
    // A programming error, not a user one: nothing else has a meter to draw down.
    throw new BadRequestError(`${feature} is not a metered feature`, ERROR_CODES.INVALID_PLAN);
  }

  const snapshot = await forGroup(group._id, now);
  assertAllowed(snapshot, feature, group);

  const allowance = policy.allowanceFor(snapshot.plan, feature);
  const claimed = await entitlementRepository.tryConsume(
    group._id,
    feature,
    snapshot.period,
    allowance,
    count
  );

  if (!claimed) {
    /**
     * Lost the race — somebody else took the last one between the check above and
     * the claim. The same refusal as if it had been gone all along, because from
     * this caller's point of view it now is.
     */
    const fresh = await forGroup(group._id, now);
    const error = new ForbiddenError(
      ["That was the last one this month.", STILL_WORKS[feature]].filter(Boolean).join(" "),
      ERROR_CODES.FEATURE_LIMIT_REACHED
    );
    error.details = refusalDetails(feature, fresh, group);
    throw error;
  }

  const used = (snapshot.usage[feature] || 0) + count;

  return {
    ...snapshot,
    usage: { ...snapshot.usage, [feature]: used },
    limits: policy.limitsFor(snapshot.plan, { ...snapshot.usage, [feature]: used }, now),
    remaining: policy.remainingFor(snapshot.plan, feature, used),
  };
};

/**
 * Hand a claimed use back, for a metered call that was charged and then failed.
 *
 * Never allowed to throw: it runs in the failure path of something that has
 * already gone wrong, and turning "the receipt scan failed" into "the receipt scan
 * failed and so did the refund" helps nobody. A refund that is silently lost costs
 * the group one scan; an exception here costs them the error message.
 */
const refund = async (group, feature, count = 1, now = new Date()) => {
  try {
    await entitlementRepository.refund(group._id, feature, periodKey(now), count);
  } catch (error) {
    logger.warn(`[entitlement] Could not refund ${feature} for group ${group._id}: ${error.message}`);
  }
};

/**
 * Give a group a plan.
 *
 * `days` extends whatever is left rather than replacing it — see policy.nextExpiry
 * for why that is the only honest arithmetic — and `null` means open-ended, which
 * only an operator can ask for.
 *
 * There is no payment here and there is not meant to be. Proving that people want
 * the features, using grants issued by hand and by referral, is the whole reason
 * entitlement is built before checkout (§14).
 */
const grant = async ({
  group,
  plan = PLANS.GROUP_PRO,
  days = config.entitlement.defaultGrantDays,
  status = PLAN_STATUS.ACTIVE,
  source = GRANT_SOURCES.ADMIN,
  paidByUserId = null,
  grantedByEmail = null,
  note = "",
  now = new Date(),
}) => {
  if (!policy.isPaidPlan(plan)) {
    throw new BadRequestError(
      `${plan} is not something that can be granted — FREE is what a group has when nothing is.`,
      ERROR_CODES.INVALID_PLAN
    );
  }

  if (days !== null && days > config.entitlement.maxGrantDays) {
    throw new BadRequestError(
      `A grant can run for at most ${config.entitlement.maxGrantDays} days.`,
      ERROR_CODES.INVALID_PLAN
    );
  }

  const existing = await entitlementRepository.findByGroup(group._id);
  const expiresAt = policy.nextExpiry(existing, days, now);

  const row = await entitlementRepository.upsert(group._id, {
    plan,
    status,
    expiresAt,
    source,
    /**
     * Only ever set, never cleared by a grant that omits it. A trip pass bought by
     * a second member must not erase who the subscription belongs to — that
     * reference is how the first payer cancels or gets refunded.
     */
    ...(paidByUserId ? { paidByUserId } : {}),
    ...(grantedByEmail ? { grantedByEmail } : {}),
    ...(note ? { note } : {}),
  });

  logger.info(
    `[entitlement] Group ${group._id} granted ${plan} until ${expiresAt ? expiresAt.toISOString() : "further notice"} (${source})`
  );

  return forGroup(group._id, now);
};

/**
 * End a group's plan now.
 *
 * Expiry rather than deletion, so there is still a record of what was granted and
 * why it stopped. The group keeps every expense, share and settlement it has —
 * those are its financial record, not a feature — and it keeps the ability to add
 * more. That is the one hard rule about downgrades (§6), and it holds here by
 * construction: this function touches one date on one row and nothing else.
 */
const revoke = async (group, { note = "" } = {}, now = new Date()) => {
  await entitlementRepository.expireNow(group._id, note);
  logger.info(`[entitlement] Group ${group._id} plan revoked`);
  return forGroup(group._id, now);
};

module.exports = {
  periodKey,
  forGroup,
  assertAllowed,
  assertWithinDepth,
  assertCapacity,
  consume,
  refund,
  grant,
  revoke,
  FEATURES,
};
