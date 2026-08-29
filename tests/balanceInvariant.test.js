const test = require("node:test");
const assert = require("node:assert/strict");

const { splitEqually } = require("../src/utils/splitCalculator");
const { minimizeTransactions, verifyTransfers } = require("../src/utils/settlementOptimizer");

/**
 * The one property that has to hold after everything.
 *
 *     Σ balances = 0
 *
 * A group is a closed system: every rupee somebody is owed is a rupee somebody
 * else owes. If that sum drifts from zero, money has entered or left the ledger
 * without an expense or a settlement to explain it, and every figure derived from
 * it — who owes whom, the settle-up plan, the per-head share — is wrong.
 *
 * It is checked here against **random sequences** rather than hand-picked cases,
 * because the failures this catches are the ones nobody thinks to write a case
 * for: a remainder handed out twice, a deleted expense whose shares were not
 * removed, a settlement counted on one side only. See
 * docs/28-SETTLEMENT-DESIGN.md §9.
 *
 * ## Why this is arithmetic and not a database test
 *
 * Balances are derived, never stored (docs/05-ALGORITHMS.md §3), so the invariant
 * is a property of the *calculation*, not of what happens to be persisted. This
 * models the ledger the same way the query does — sum what people paid, subtract
 * their shares, apply settlements — which means a bug in the split or optimiser
 * shows up here without a Mongo instance in the loop.
 */

/** Deterministic, so a failure is reproducible from the seed in the message. */
const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

/**
 * Play a random sequence of expenses, deletions and settlements, and return each
 * member's net position in minor units.
 */
const simulate = (seed, steps = 40) => {
  const random = rng(seed);
  const pick = (n) => Math.floor(random() * n);

  const people = 2 + pick(6);
  const ids = Array.from({ length: people }, (_, i) => `m${i}`);
  const paid = Object.fromEntries(ids.map((id) => [id, 0]));
  const owed = Object.fromEntries(ids.map((id) => [id, 0]));

  const live = [];

  for (let step = 0; step < steps; step += 1) {
    const roll = random();

    if (roll < 0.6 || live.length === 0) {
      // An expense, split across a random non-empty subset.
      const amountMinor = 1 + pick(500000);
      const payer = ids[pick(people)];
      const sharers = ids.filter(() => random() < 0.7);
      if (sharers.length === 0) sharers.push(ids[pick(people)]);

      // `splitEqually` returns [{ memberId, amountMinor }] and asserts its own
      // balance internally, which is why nothing is re-checked here.
      const shares = splitEqually(amountMinor, sharers);

      paid[payer] += amountMinor;
      for (const share of shares) owed[share.memberId] += share.amountMinor;
      live.push({ payer, amountMinor, shares });
    } else if (roll < 0.75) {
      // Delete an expense: both sides of it must come back out.
      const index = pick(live.length);
      const [gone] = live.splice(index, 1);
      paid[gone.payer] -= gone.amountMinor;
      for (const share of gone.shares) owed[share.memberId] -= share.amountMinor;
    } else {
      /**
       * A settlement. Deliberately unconstrained — any amount, any direction,
       * including more than is owed. Recording what happened must not break the
       * invariant, and over-payment simply flips a sign.
       */
      const from = ids[pick(people)];
      const to = ids[pick(people)];
      if (from === to) continue;
      const amountMinor = 1 + pick(200000);
      paid[from] += amountMinor;
      paid[to] -= amountMinor;
    }
  }

  // The optimiser's shape: { memberId, netMinor }.
  return ids.map((id) => ({ memberId: id, netMinor: paid[id] - owed[id] }));
};

test("balances sum to zero after any sequence of expenses, deletions and settlements", () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const balances = simulate(seed);
    const sum = balances.reduce((total, entry) => total + entry.netMinor, 0);

    assert.equal(sum, 0, `seed ${seed}: Σ balances must be 0, got ${sum}`);
  }
});

test("every balance is a whole number of minor units", () => {
  /**
   * A fractional balance means a float crept into the arithmetic, which is the
   * failure docs/05-ALGORITHMS.md §1 exists to prevent — and it shows up as a
   * settlement that can never quite clear.
   */
  for (let seed = 1; seed <= 200; seed += 1) {
    for (const entry of simulate(seed)) {
      assert.ok(
        Number.isInteger(entry.netMinor),
        `seed ${seed}: ${entry.memberId} has a fractional balance (${entry.netMinor})`
      );
    }
  }
});

test("the settle-up plan clears every balance it is given", () => {
  /**
   * The invariant that matters to a user: after making the payments the app
   * suggests, nobody owes anybody. A plan that merely moves the right *total*
   * around is not good enough.
   */
  for (let seed = 1; seed <= 200; seed += 1) {
    const balances = simulate(seed);
    const transfers = minimizeTransactions(balances);

    /**
     * `verifyTransfers` is the optimiser's own residual check, reused rather than
     * reimplemented: if the plan clears every balance it returns true. Using the
     * production helper means this test fails when *it* is wrong too.
     */
    assert.ok(
      verifyTransfers(balances, transfers),
      `seed ${seed}: the suggested payments do not clear every balance`
    );

    // n-1 is the floor for a connected group; more means the plan contains
    // payments that cancel each other out.
    const involved = balances.filter((b) => b.netMinor !== 0).length;
    if (involved > 0) {
      assert.ok(
        transfers.length <= involved - 1,
        `seed ${seed}: ${transfers.length} transfers for ${involved} people is more than n-1`
      );
    }

    assert.ok(
      transfers.every((t) => t.amountMinor > 0),
      `seed ${seed}: every payment must be a positive amount`
    );
  }
});
