const config = require("../config/env");
const {
  PLANS,
  PLAN_STATUS,
  FEATURES,
  FEATURE_KINDS,
  FEATURE_SPECS,
} = require("../constants");

/**
 * What a plan is worth, as pure functions (docs/22-MONETIZATION.md §6–§7).
 *
 * Everything here takes a stored row and a usage tally and returns a decision. No
 * database, no clock of its own — `now` is always passed in — which is what makes
 * the rules in §2 testable rather than merely stated: `tests/entitlement.test.js`
 * asserts that the free tier stays whole, that "unlimited" is never offered on
 * anything metered, and that an expired plan degrades to FREE rather than to
 * nothing.
 *
 * The database half lives in services/entitlementService.js.
 *
 * ## The one rule this file exists to protect
 *
 * > Never charge for the reason someone invites their flatmates.
 *
 * Adding an expense, splitting it, seeing balances and settling up are not
 * features here and cannot be gated by anything in this file, because they are
 * absent from `FEATURES` altogether. Downgrading therefore cannot take them away —
 * there is no code path that could.
 */

/** Plans that are paid for. FREE is the absence of one. */
const PAID_PLANS = Object.freeze([PLANS.GROUP_PRO, PLANS.TRIP_PASS]);

const isPaidPlan = (plan) => PAID_PLANS.includes(plan);

/**
 * Has this grant run out?
 *
 * `expiresAt: null` means it never does — a permanent promo, or an operator grant
 * made deliberately open-ended. Null is *not* treated as "expired at the epoch",
 * which is the failure this predicate is written the long way round to avoid.
 */
const isExpired = (row, now = new Date()) => {
  if (!row) return true;
  if (!row.expiresAt) return false;
  return new Date(row.expiresAt).getTime() <= now.getTime();
};

/**
 * The plan a group is **actually** on right now.
 *
 * No row and an expired row are the same answer — FREE — and deliberately so: it
 * means a group that stops paying needs no sweep job to be downgraded, and a group
 * that never paid needs no row to be created. Expiry is a fact about a date, and
 * asking the date is cheaper and more reliable than maintaining a mirror of it.
 */
const effectivePlan = (row, now = new Date()) =>
  !row || isExpired(row, now) ? PLANS.FREE : row.plan;

/**
 * Where the plan is in its life, as reported to the client.
 *
 * A row that has run out reads `EXPIRED` rather than `FREE`, even though it grants
 * exactly what FREE grants. The distinction is worth a string: "your plan ended on
 * the 3rd" and "you have never had a plan" are different sentences to show
 * somebody, and only one of them is worth interrupting them with.
 */
const statusOf = (row, now = new Date()) => {
  if (!row) return PLAN_STATUS.FREE;
  if (isExpired(row, now)) return PLAN_STATUS.EXPIRED;
  return row.status || PLAN_STATUS.ACTIVE;
};

/** The allowance table this plan draws from. Both paid plans share one — see config. */
const allowancesFor = (plan) =>
  !isPaidPlan(plan) ? config.entitlement.paid : config.entitlement.free;

/**
 * The raw allowance for one feature under one plan.
 *
 * Returns a number for METERED and CAPACITY, `null` or a number of months for
 * DEPTH, and a boolean for FLAG. Callers are expected to know which they asked
 * for — `FEATURE_SPECS[feature].kind` says so.
 */
const allowanceFor = (plan, feature) => {
  const spec = FEATURE_SPECS[feature];
  if (!spec) return 0;
  return allowancesFor(plan)[spec.allowanceKey];
};

/**
 * How many uses of a metered feature are left this period.
 *
 * Floored at zero because a negative remainder is not a thing anybody wants to
 * read, and because usage can legitimately exceed the allowance: a plan that
 * lapses mid-month leaves a group that has already used 40 of a paid 50 holding a
 * free allowance of 3. The honest answer there is "none left", not "-37".
 */
const remainingFor = (plan, feature, used = 0) => {
  const allowance = allowanceFor(plan, feature);
  if (typeof allowance !== "number") return 0;
  return Math.max(0, allowance - Math.max(0, used));
};

/**
 * Can this group use this feature *right now*?
 *
 * For a metered feature that means the plan permits it **and** the allowance has
 * not run out, which is the only reading that makes §7's "limits before locks"
 * expressible: a free group with three receipt scans left can scan, and the same
 * group on its fourth cannot. One boolean the UI can trust, rather than a flag
 * that says "no" while a separate counter says "three left".
 *
 * The server re-checks at the point of use regardless (§6). This is for drawing
 * the screen, and a client that has been told `false` and posts anyway is refused
 * by the endpoint, not by the button.
 */
const canUse = (plan, feature, usage = {}) => {
  const spec = FEATURE_SPECS[feature];
  if (!spec) return false;

  const allowance = allowanceFor(plan, feature);

  if (spec.kind === FEATURE_KINDS.FLAG) return Boolean(allowance);
  if (spec.kind === FEATURE_KINDS.DEPTH) return allowance === null || allowance > 0;
  if (spec.kind === FEATURE_KINDS.CAPACITY) return allowance > 0;

  return remainingFor(plan, feature, usage[feature] || 0) > 0;
};

/**
 * The `features` block: one boolean per gated feature, plus ads.
 *
 * `ads` is the odd one out and reads backwards from the rest — `true` means this
 * group **sees** ads, where every other key means "may do this". It is kept in the
 * same block because that is what the client renders from, and it is deliberately
 * not a member of `FEATURES`: nothing grants it, nothing consumes it, and a
 * `requireFeature("ads")` would be a guard whose polarity is a coin flip.
 *
 * Ad-free is only a benefit once ads are live (§9), which they are not — so today
 * this reports what would happen rather than what does.
 */
const featuresFor = (plan, usage = {}) => {
  const features = {};

  for (const feature of Object.values(FEATURES)) {
    features[feature] = canUse(plan, feature, usage);
  }

  features.ads = !isPaidPlan(plan);

  return features;
};

/** First instant of next month, UTC — when every metered allowance comes back. */
const resetsOn = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/**
 * The earliest date a DEPTH feature may look back to, or `null` for all of it.
 *
 * Counted in whole months from the start of the current one, so an allowance of 1
 * means "this month" rather than "the last thirty days". That matters because the
 * thing being bounded is a *month view*: a rolling window would put half of July
 * inside a free group's August breakdown and the other half behind a wall, which
 * is impossible to explain and looks like a bug.
 */
const depthFloor = (plan, feature, now = new Date()) => {
  const months = allowanceFor(plan, feature);
  if (months === null || months === undefined) return null;
  if (typeof months !== "number" || months <= 0) return null;

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
};

/** Whether a requested start date is inside what this plan may see. */
const withinDepth = (plan, feature, from, now = new Date()) => {
  const floor = depthFloor(plan, feature, now);
  if (!floor) return true;
  // No start date means "everything", which only an unbounded plan may ask for.
  if (!from) return false;
  return new Date(from).getTime() >= floor.getTime();
};

/**
 * The `limits` block: what remains, or what the ceiling is.
 *
 * Metered features report what is **left**, because that is the number the wall
 * has to say out loud (§8). The others report the ceiling, because the client can
 * already count what it holds.
 *
 * Never contains a price. What something costs is a question for the upgrade
 * screen, from a pricing endpoint, so that a stale cache cannot quote a figure
 * that has changed (§6).
 */
const limitsFor = (plan, usage = {}, now = new Date()) => {
  const limits = {};

  for (const [feature, spec] of Object.entries(FEATURE_SPECS)) {
    if (!spec.limitKey) continue;

    limits[spec.limitKey] =
      spec.kind === FEATURE_KINDS.METERED
        ? remainingFor(plan, feature, usage[feature] || 0)
        : allowanceFor(plan, feature);
  }

  /** When the metered ones come back. Absent from §6's sketch; the wall needs it. */
  limits.resetsOn = resetsOn(now);

  return limits;
};

/**
 * Everything the client is told about a group's plan, in one object.
 *
 * `usage` is a plain `{ [feature]: number }` for the current month, which the
 * service reads and this file never fetches.
 */
const snapshot = (row, usage = {}, now = new Date()) => {
  const plan = effectivePlan(row, now);

  return {
    plan,
    status: statusOf(row, now),
    /** Null on FREE — there is nothing to run out. */
    expiresAt: plan === PLANS.FREE ? null : row?.expiresAt || null,
    features: featuresFor(plan, usage),
    limits: limitsFor(plan, usage, now),
  };
};

/** `expiresAt` for a grant of N days from now. Null days means open-ended. */
const expiryFromDays = (days, from = new Date()) => {
  if (days === null || days === undefined) return null;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
};

/**
 * When a grant of N days should end, given what the group already has.
 *
 * Adds to whatever is **left** rather than replacing it. A group with 20 days
 * remaining that is given 30 more has 50, not 30 — replacing would quietly take
 * days somebody paid for, and the same arithmetic is what lets a referral payout
 * (§11) stack honestly on top of a subscription instead of competing with it.
 *
 * Two cases collapse to "start from now": no row at all, and a row that has
 * already run out. Neither has any remaining time to add to, and treating a plan
 * that lapsed in March as a base would produce a grant that is over before it is
 * made.
 *
 * `days: null` means open-ended, and an already open-ended row stays that way —
 * there is nothing to extend.
 */
const nextExpiry = (row, days, now = new Date()) => {
  if (days === null || days === undefined) return null;
  if (row && row.expiresAt === null && !isExpired(row, now)) return null;

  const current = row?.expiresAt ? new Date(row.expiresAt) : null;
  const base = current && current.getTime() > now.getTime() ? current : now;

  return expiryFromDays(days, base);
};

module.exports = {
  PAID_PLANS,
  isPaidPlan,
  isExpired,
  effectivePlan,
  statusOf,
  allowancesFor,
  allowanceFor,
  remainingFor,
  canUse,
  featuresFor,
  limitsFor,
  resetsOn,
  depthFloor,
  withinDepth,
  snapshot,
  expiryFromDays,
  nextExpiry,
};
