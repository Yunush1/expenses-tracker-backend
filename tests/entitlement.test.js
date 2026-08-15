const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * The entitlement layer's rules, as opposed to its plumbing
 * (docs/22-MONETIZATION.md).
 *
 * Four things are worth pinning here, and they are the four ways this feature
 * could quietly become the wrong product:
 *
 * 1. **The free product stays whole.** Nothing a plan can gate may ever be the
 *    reason somebody invites their flatmates. This is asserted against the feature
 *    list itself rather than against behaviour, because the failure mode is
 *    somebody *adding* a feature key one afternoon, not a function returning the
 *    wrong boolean.
 * 2. **Expiry degrades to FREE, never to nothing.** A group that stops paying must
 *    land on a working expense tracker.
 * 3. **"Unlimited" is never offered on anything metered.** A promise the provider
 *    bill does not honour costs more to withdraw than it ever earned.
 * 4. **A grant extends what is left.** Replacing would take days somebody paid for.
 *
 * `config/env` is frozen at require time, so cases that need different limits
 * re-import the policy with a fresh module registry rather than mutating it.
 */

const {
  PLANS,
  PLAN_STATUS,
  FEATURES,
  FEATURE_KINDS,
  FEATURE_SPECS,
  METERED_FEATURES,
} = require("../src/constants");

const policy = require("../src/utils/entitlementPolicy");

/** Load the policy under a given environment, isolated from the other cases. */
const withEnv = (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, { MONGO_URI: "mongodb://localhost/test", ...env });

  for (const key of Object.keys(require.cache)) {
    if (key.includes("config") || key.includes("entitlement") || key.includes("constants")) {
      delete require.cache[key];
    }
  }

  try {
    return fn(require("../src/utils/entitlementPolicy"));
  } finally {
    process.env = saved;
    for (const key of Object.keys(require.cache)) {
      if (key.includes("config") || key.includes("entitlement") || key.includes("constants")) {
        delete require.cache[key];
      }
    }
  }
};

const NOW = new Date("2026-08-14T10:00:00Z");
const days = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const paidRow = (overrides = {}) => ({
  plan: PLANS.GROUP_PRO,
  status: PLAN_STATUS.ACTIVE,
  expiresAt: days(10),
  ...overrides,
});

/* --------------------- 1. The free product stays whole -------------------- */

test("nothing a plan can gate is part of the core product", () => {
  /**
   * The governing rule of the whole document, enforced rather than remembered:
   * "never charge for the reason someone invites their flatmates".
   *
   * If a future feature key here matches one of these, the wall around it can be
   * put in front of adding an expense — and the product is no longer the one this
   * design is for.
   */
  const CORE = [
    "createGroup",
    "join",
    "addExpense",
    "editExpense",
    "splitEqual",
    "splitExact",
    "splitPercentage",
    "splitShares",
    "balances",
    "settle",
    "settlementSuggestions",
    "expenseHistory",
    "search",
    "filters",
    "categories",
    "periods",
    "offline",
    "voice",
    "members",
    "invite",
  ];

  const gated = Object.values(FEATURES);

  for (const core of CORE) {
    assert.ok(
      !gated.includes(core),
      `"${core}" is free forever and must never appear in FEATURES`
    );
  }
});

test("a free group can still do everything that is free", () => {
  // Expressed as an absence: the FREE plan grants no *gated* feature it should
  // not, and the core is not represented here at all — which is the point above.
  const free = policy.featuresFor(PLANS.FREE, {});

  assert.equal(free[FEATURES.CURRENCY_CONVERSION], false);
  // Ads are the odd key out: true means this group SEES them.
  assert.equal(free.ads, true);
});

test("a paid group is the same group with the ads off", () => {
  assert.equal(policy.featuresFor(PLANS.GROUP_PRO, {}).ads, false);
  assert.equal(policy.featuresFor(PLANS.TRIP_PASS, {}).ads, false);
});

/* ------------------------- 2. FREE is a real plan ------------------------- */

test("a group with no entitlement row is FREE, not broken", () => {
  const snapshot = policy.snapshot(null, {}, NOW);

  assert.equal(snapshot.plan, PLANS.FREE);
  assert.equal(snapshot.status, PLAN_STATUS.FREE);
  assert.equal(snapshot.expiresAt, null);
  // A real plan with real limits — the free allowance is expressible in the same
  // shape as a paid one, which is what makes "limits before locks" possible.
  assert.ok(snapshot.limits.receiptScansLeft >= 0);
  assert.ok(Object.keys(snapshot.features).length > 0);
});

test("an expired plan reads as FREE, and says so", () => {
  const lapsed = paidRow({ expiresAt: days(-1) });

  assert.equal(policy.effectivePlan(lapsed, NOW), PLANS.FREE);
  // EXPIRED rather than FREE, because "your plan ended" and "you never had one"
  // are different sentences to show somebody.
  assert.equal(policy.statusOf(lapsed, NOW), PLAN_STATUS.EXPIRED);
  assert.equal(policy.snapshot(lapsed, {}, NOW).expiresAt, null);
});

test("cancelled and past due still entitle the group until the date", () => {
  // A failed renewal is a conversation with the payer, not a reason to take
  // features from four other people the same afternoon.
  for (const status of [PLAN_STATUS.CANCELLED, PLAN_STATUS.PAST_DUE, PLAN_STATUS.TRIAL]) {
    const row = paidRow({ status });
    assert.equal(policy.effectivePlan(row, NOW), PLANS.GROUP_PRO, `${status} must still entitle`);
    assert.equal(policy.statusOf(row, NOW), status);
  }
});

test("an open-ended grant never expires", () => {
  const forever = paidRow({ expiresAt: null });

  assert.equal(policy.isExpired(forever, NOW), false);
  assert.equal(policy.isExpired(forever, new Date("2099-01-01T00:00:00Z")), false);
  assert.equal(policy.effectivePlan(forever, NOW), PLANS.GROUP_PRO);
});

test("expiry is inclusive of the instant it names", () => {
  // A plan that ends at 10:00 is over at 10:00, not at 10:00:00.001.
  assert.equal(policy.isExpired(paidRow({ expiresAt: NOW }), NOW), true);
});

/* ----------------- 3. Nothing metered is ever unlimited ------------------- */

test("every metered feature has a finite allowance on every plan", () => {
  assert.ok(METERED_FEATURES.length > 0, "there should be metered features to check");

  for (const plan of [PLANS.FREE, PLANS.GROUP_PRO, PLANS.TRIP_PASS]) {
    for (const feature of METERED_FEATURES) {
      const allowance = policy.allowanceFor(plan, feature);

      assert.equal(
        typeof allowance,
        "number",
        `${plan}/${feature} must be a number — "unlimited" is a promise the provider bill does not honour`
      );
      assert.ok(Number.isFinite(allowance), `${plan}/${feature} must be finite`);
    }
  }
});

test("an unlimited depth is expressed as null, and only for depth", () => {
  withEnv({ ENTITLEMENT_PAID_ANALYTICS_MONTHS: "0" }, (fresh) => {
    // Zero months in the environment means the whole history.
    assert.equal(fresh.allowanceFor(PLANS.GROUP_PRO, FEATURES.CATEGORY_ANALYTICS), null);
    assert.equal(fresh.canUse(PLANS.GROUP_PRO, FEATURES.CATEGORY_ANALYTICS), true);
  });

  withEnv({ ENTITLEMENT_PAID_RECEIPT_SCANS: "0" }, (fresh) => {
    // The same "0" on a metered feature means none, never unlimited.
    assert.equal(fresh.allowanceFor(PLANS.GROUP_PRO, FEATURES.RECEIPT_SCAN), 0);
    assert.equal(fresh.canUse(PLANS.GROUP_PRO, FEATURES.RECEIPT_SCAN), false);
  });
});

/* ------------------------- Limits before locks ---------------------------- */

test("a free group may use a metered feature until its allowance is gone", () => {
  withEnv({ ENTITLEMENT_FREE_RECEIPT_SCANS: "3" }, (fresh) => {
    const feature = FEATURES.RECEIPT_SCAN;

    // A feature nobody has tried is a feature nobody will pay for.
    assert.equal(fresh.canUse(PLANS.FREE, feature, {}), true);
    assert.equal(fresh.canUse(PLANS.FREE, feature, { [feature]: 2 }), true);
    assert.equal(fresh.canUse(PLANS.FREE, feature, { [feature]: 3 }), false);

    // And the boolean and the counter agree, always — one is derived from the other.
    for (const used of [0, 1, 2, 3, 4]) {
      const snapshot = fresh.snapshot(null, { [feature]: used }, NOW);
      assert.equal(
        snapshot.features[feature],
        snapshot.limits.receiptScansLeft > 0,
        `features and limits disagree at used=${used}`
      );
    }
  });
});

test("remaining floors at zero when usage outlived the plan it was earned under", () => {
  withEnv({ ENTITLEMENT_FREE_RECEIPT_SCANS: "3", ENTITLEMENT_PAID_RECEIPT_SCANS: "50" }, (fresh) => {
    // 40 scans used on a plan that has since lapsed. "-37 left" is not a thing
    // anybody wants to read.
    assert.equal(fresh.remainingFor(PLANS.FREE, FEATURES.RECEIPT_SCAN, 40), 0);
  });
});

test("the limits block reports what is left, and the ceiling for the rest", () => {
  const limits = policy.limitsFor(PLANS.FREE, { [FEATURES.RECEIPT_SCAN]: 1 }, NOW);

  for (const [feature, spec] of Object.entries(FEATURE_SPECS)) {
    if (!spec.limitKey) continue;
    assert.ok(spec.limitKey in limits, `${feature} is missing from limits`);
  }

  // Metered keys are named for what remains — that is the number the wall says.
  assert.equal(
    limits.receiptScansLeft,
    policy.allowanceFor(PLANS.FREE, FEATURES.RECEIPT_SCAN) - 1
  );
  // A capacity key is the ceiling, because the client can count what it holds.
  assert.equal(
    limits.recurringExpenses,
    policy.allowanceFor(PLANS.FREE, FEATURES.RECURRING_EXPENSES)
  );
});

test("the payload never carries a price", () => {
  /**
   * §6, and it is a rule about caching rather than about secrecy: a summary
   * sitting in a client's storage from last week must not be able to quote a
   * figure that has since changed.
   */
  const wire = JSON.stringify(policy.snapshot(paidRow(), {}, NOW));

  for (const smell of ["price", "amount", "cost", "₹", "$", "inr", "usd"]) {
    assert.ok(!wire.toLowerCase().includes(smell), `the entitlement payload mentions "${smell}"`);
  }

  /**
   * "currency" appears exactly once and is not a price: `currencyConversion` is
   * the FX feature. Asserted rather than excluded from the list above, so that a
   * second, actually monetary use of the word would still be caught.
   */
  assert.equal(
    (wire.match(/currency/gi) || []).length,
    1,
    "the only currency in this payload should be the conversion feature flag"
  );
});

test("allowances reset at the start of next month, in UTC", () => {
  // Per group and per calendar month, so a group travelling east does not get a
  // second allowance for crossing a date line.
  assert.equal(policy.resetsOn(NOW).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(
    policy.resetsOn(new Date("2026-12-31T23:59:59Z")).toISOString(),
    "2027-01-01T00:00:00.000Z"
  );
});

/* ---------------------------- 4. Grant arithmetic ------------------------- */

test("a grant to a group with nothing starts from now", () => {
  assert.equal(policy.nextExpiry(null, 30, NOW).toISOString(), days(30).toISOString());
});

test("a grant extends what is left rather than replacing it", () => {
  // 20 days remaining plus 30 granted is 50, not 30. Replacing would quietly take
  // days somebody paid for.
  const row = paidRow({ expiresAt: days(20) });
  assert.equal(policy.nextExpiry(row, 30, NOW).toISOString(), days(50).toISOString());
});

test("a grant on a lapsed plan starts from now, not from when it lapsed", () => {
  // Otherwise 30 days granted to a plan that ended in March is over before it is made.
  const lapsed = paidRow({ expiresAt: days(-90) });
  assert.equal(policy.nextExpiry(lapsed, 30, NOW).toISOString(), days(30).toISOString());
});

test("an open-ended plan stays open-ended, and a null grant makes one", () => {
  assert.equal(policy.nextExpiry(paidRow({ expiresAt: null }), 30, NOW), null);
  assert.equal(policy.nextExpiry(paidRow(), null, NOW), null);
});

test("FREE cannot be granted, because it is what a group has when nothing is", () => {
  assert.equal(policy.isPaidPlan(PLANS.FREE), false);
  assert.equal(policy.isPaidPlan(PLANS.GROUP_PRO), true);
  assert.equal(policy.isPaidPlan(PLANS.TRIP_PASS), true);
});

/* ------------------------------- Consistency ------------------------------ */

test("the two paid plans differ in term, not in what they unlock", () => {
  // §5's table: a trip pass ends by itself, a subscription renews. Nothing else.
  assert.deepEqual(
    policy.featuresFor(PLANS.GROUP_PRO, {}),
    policy.featuresFor(PLANS.TRIP_PASS, {})
  );
});

test("every feature has a spec, and every spec has a kind the policy understands", () => {
  const kinds = new Set(Object.values(FEATURE_KINDS));

  for (const feature of Object.values(FEATURES)) {
    const spec = FEATURE_SPECS[feature];
    assert.ok(spec, `${feature} has no spec`);
    assert.ok(kinds.has(spec.kind), `${feature} has an unknown kind`);
    assert.ok(spec.allowanceKey, `${feature} has nowhere to read its allowance from`);
    // A flag has nothing to count, so it is the only kind allowed no limit key.
    if (spec.kind !== FEATURE_KINDS.FLAG) {
      assert.ok(spec.limitKey, `${feature} must report a limit`);
    }
  }
});

/* --------------------------- Referral payouts ----------------------------- */

test("a referral pays the configured number of days", () => {
  withEnv({ ENTITLEMENT_REFERRAL_DAYS: "45" }, () => {
    const config = require("../src/config/env");
    assert.equal(config.entitlement.referralGrantDays, 45);
  });
});

test("zero days switches the plan-days payout off without touching points", () => {
  /**
   * The off switch matters because the two halves of a referral are independent:
   * an operator who wants points but not plan days sets this to 0, and the points
   * economy — a separate set of variables entirely — must be unaffected.
   */
  withEnv({ ENTITLEMENT_REFERRAL_DAYS: "0", REFERRAL_BASE_POINTS: "100" }, () => {
    const config = require("../src/config/env");

    assert.equal(config.entitlement.referralGrantDays, 0);
    assert.equal(config.referral.basePoints, 100, "points are a separate economy");
  });
});

test("a negative or nonsense day count reads as off, never as a debt", () => {
  for (const value of ["-30", "abc", ""]) {
    withEnv({ ENTITLEMENT_REFERRAL_DAYS: value }, () => {
      const days = require("../src/config/env").entitlement.referralGrantDays;
      assert.ok(days >= 0, `"${value}" produced ${days}`);
    });
  }
});

test("an unknown feature is refused rather than waved through", () => {
  // A typo in a `requireFeature("recieptScan")` must fail closed.
  assert.equal(policy.canUse(PLANS.GROUP_PRO, "recieptScan", {}), false);
  assert.equal(policy.allowanceFor(PLANS.GROUP_PRO, "nonsense"), 0);
});
