const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Monthly dues, offsets and merges — the arithmetic in utils/periodDues.js
 * (docs/29-BALANCE-CYCLES.md).
 *
 * The scenarios are the PRD's own, plus the A1/A2 → A4 merge it was extended
 * with. The property test at the end is the one that matters most: whatever the
 * sequence of expenses, payments, offsets and merges, every month sums to zero
 * and the months together equal the all-time balance the rest of the app shows.
 * If those two ever disagree, a person is being told two different amounts.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/splitly-test";

const dues$ = require("../src/utils/periodDues");

const TZ = "Asia/Kolkata";
const A1 = "a1";
const A2 = "a2";
const A3 = "a3";
const A4 = "a4";

/** What expenseRepository.pairDebtsByMonth returns, computed in memory. */
const debtsOf = (expenses) => {
  const rows = new Map();
  for (const expense of expenses) {
    const periodKey = dues$.periodKeyOf(expense.date, TZ);
    for (const [memberId, amountMinor] of Object.entries(expense.shares)) {
      if (memberId === expense.paidBy) continue;
      const key = `${periodKey}|${memberId}|${expense.paidBy}`;
      const row = rows.get(key) || { periodKey, fromMemberId: memberId, toMemberId: expense.paidBy, amountMinor: 0 };
      row.amountMinor += amountMinor;
      rows.set(key, row);
    }
  }
  return [...rows.values()];
};

/** balanceService's formula: paid − share + settlementsPaid − settlementsReceived. */
const allTimeNets = (expenses, settlements) => {
  const nets = new Map();
  const add = (id, amount) => nets.set(id, (nets.get(id) || 0) + amount);
  for (const expense of expenses) {
    add(expense.paidBy, Object.values(expense.shares).reduce((a, b) => a + b, 0));
    for (const [memberId, amount] of Object.entries(expense.shares)) add(memberId, -amount);
  }
  for (const settlement of settlements) {
    add(settlement.fromMemberId, settlement.amountMinor);
    add(settlement.toMemberId, -settlement.amountMinor);
  }
  return nets;
};

const build = (expenses, settlements = []) =>
  dues$.buildDues({ debts: debtsOf(expenses), settlements, timeZone: TZ });

const find = (dues, periodKey, from, to) =>
  dues.find((due) => due.periodKey === periodKey && due.fromMemberId === from && due.toMemberId === to)
    ?.amountMinor || 0;

/** Each month nets to zero, and the months together are the all-time balance. */
const assertConsistent = (expenses, settlements) => {
  const dues = build(expenses, settlements);
  const periods = new Set(dues.map((due) => due.periodKey));
  const summed = new Map();

  for (const periodKey of periods) {
    const nets = dues$.netsForPeriod(dues, periodKey);
    const total = [...nets.values()].reduce((a, b) => a + b, 0);
    assert.equal(total, 0, `${periodKey} does not net to zero`);
    for (const [id, net] of nets) summed.set(id, (summed.get(id) || 0) + net);
  }

  const expected = allTimeNets(expenses, settlements);
  for (const id of new Set([...expected.keys(), ...summed.keys()])) {
    assert.equal(summed.get(id) || 0, expected.get(id) || 0, `month dues for ${id} disagree with the all-time balance`);
  }
  return dues;
};

/** The two rows an offset or merge writes, as settlements. */
const pairRows = (first, second) => [first, second].map((row) => ({ ...row, settledAt: new Date() }));

const SEPT = new Date("2026-09-15T06:00:00Z");
const OCT = new Date("2026-10-10T06:00:00Z");

/** September: A1 and A3 each owe A2 ₹1,000 — the PRD's running example. */
const september = [
  { date: SEPT, paidBy: A2, shares: { [A1]: 100000, [A3]: 100000, [A2]: 0 } },
];

test("a month's dues are pairwise and stay in their month (PRD §2, §13)", () => {
  // October: A3 pays ₹300 of groceries, split three ways.
  const october = [{ date: OCT, paidBy: A3, shares: { [A1]: 10000, [A2]: 10000, [A3]: 10000 } }];
  const dues = assertConsistent([...september, ...october], []);

  // September is untouched by October's spending — not ₹700, not ₹800.
  assert.equal(find(dues, "2026-09", A3, A2), 100000);
  assert.equal(find(dues, "2026-09", A1, A2), 100000);
  // October stands alone.
  assert.equal(find(dues, "2026-10", A1, A3), 10000);
  assert.equal(find(dues, "2026-10", A2, A3), 10000);
});

test("a month is cut in the configured zone, not UTC", () => {
  // 18:00Z on the 30th is 23:30 IST — still September. 19:00Z is 00:30 IST on
  // 1 October, so a late-night expense in India belongs to October's dues even
  // though it is still the 30th in UTC.
  assert.equal(dues$.periodKeyOf(new Date("2026-09-30T18:00:00Z"), TZ), "2026-09");
  assert.equal(dues$.periodKeyOf(new Date("2026-09-30T19:00:00Z"), TZ), "2026-10");
});

test("a payment with no month pays the oldest due first; a named month gets all of it", () => {
  const dues = build([
    ...september,
    { date: OCT, paidBy: A2, shares: { [A3]: 30000, [A2]: 30000 } },
  ]);

  assert.deepEqual(
    dues$.allocatePayment({ dues, fromMemberId: A3, toMemberId: A2, amountMinor: 110000, currentPeriodKey: "2026-10" }),
    [
      { periodKey: "2026-09", amountMinor: 100000 },
      { periodKey: "2026-10", amountMinor: 10000 },
    ]
  );

  assert.deepEqual(
    dues$.allocatePayment({ dues, fromMemberId: A3, toMemberId: A2, amountMinor: 30000, currentPeriodKey: "2026-10", periodKey: "2026-10" }),
    [{ periodKey: "2026-10", amountMinor: 30000 }]
  );
});

test("paying more than is owed lands in the current month as an overpayment", () => {
  const dues = build(september);
  const allocations = dues$.allocatePayment({ dues, fromMemberId: A1, toMemberId: A2, amountMinor: 150000, currentPeriodKey: "2026-10" });
  assert.deepEqual(allocations, [
    { periodKey: "2026-09", amountMinor: 100000 },
    { periodKey: "2026-10", amountMinor: 50000 },
  ]);

  const settlements = [{ fromMemberId: A1, toMemberId: A2, amountMinor: 150000, allocations, settledAt: OCT }];
  const after = assertConsistent(september, settlements);
  assert.equal(find(after, "2026-09", A1, A2), 0);
  assert.equal(find(after, "2026-10", A2, A1), 50000, "A2 now owes A1 the excess, this month");
});

test("a partial payment leaves the rest of the month owing", () => {
  const dues = build(september);
  const allocations = dues$.allocatePayment({ dues, fromMemberId: A3, toMemberId: A2, amountMinor: 40000, currentPeriodKey: "2026-10" });
  const after = assertConsistent(september, [{ fromMemberId: A3, toMemberId: A2, amountMinor: 40000, allocations, settledAt: OCT }]);
  assert.equal(find(after, "2026-09", A3, A2), 60000);
});

test("an offset cancels opposite debts in different months and moves no money", () => {
  const october = [{ date: OCT, paidBy: A3, shares: { [A2]: 10000, [A3]: 10000 } }]; // A2 owes A3 ₹100
  const expenses = [...september, ...october];
  const dues = build(expenses);

  const plan = dues$.planOffset({ dues, aMemberId: A3, bMemberId: A2 });
  assert.equal(plan.amountMinor, 10000);

  const rows = pairRows(
    { fromMemberId: A3, toMemberId: A2, amountMinor: plan.amountMinor, allocations: plan.aToB },
    { fromMemberId: A2, toMemberId: A3, amountMinor: plan.amountMinor, allocations: plan.bToA }
  );
  const after = assertConsistent(expenses, rows);

  assert.equal(find(after, "2026-09", A3, A2), 90000);
  assert.equal(find(after, "2026-10", A2, A3), 0);
  // All-time positions are exactly what they were before the offset.
  assert.deepEqual(allTimeNets(expenses, rows), allTimeNets(expenses, []));
});

test("there is nothing to offset when the debts all run one way", () => {
  assert.equal(dues$.planOffset({ dues: build(september), aMemberId: A1, bMemberId: A2 }), null);
});

test("A1 and A2 merge their September dues to A4 into October, then October's spending pays them down", () => {
  const sept = [{ date: SEPT, paidBy: A4, shares: { [A1]: 100000, [A2]: 80000, [A4]: 0 } }];
  let settlements = [];

  for (const [debtor, amount] of [[A1, 100000], [A2, 80000]]) {
    const plan = dues$.planMerge({ dues: build(sept, settlements), fromMemberId: debtor, toMemberId: A4, currentPeriodKey: "2026-10" });
    assert.equal(plan.amountMinor, amount);
    settlements = settlements.concat(
      pairRows(
        { fromMemberId: debtor, toMemberId: A4, amountMinor: plan.amountMinor, allocations: plan.clearing },
        { fromMemberId: A4, toMemberId: debtor, amountMinor: plan.amountMinor, allocations: plan.carrying }
      )
    );
  }

  let dues = assertConsistent(sept, settlements);
  assert.equal(find(dues, "2026-09", A1, A4), 0, "September is cleared");
  assert.equal(find(dues, "2026-09", A2, A4), 0);
  assert.equal(find(dues, "2026-10", A1, A4), 100000, "…and carried into October");
  assert.equal(find(dues, "2026-10", A2, A4), 80000);
  assert.deepEqual(allTimeNets(sept, settlements), allTimeNets(sept, []), "a merge moves no money");

  // October: A1 pays ₹1,200 of groceries split four ways. A4's ₹300 share comes off.
  const oct = [{ date: OCT, paidBy: A1, shares: { [A1]: 30000, [A2]: 30000, [A3]: 30000, [A4]: 30000 } }];
  dues = assertConsistent([...sept, ...oct], settlements);
  assert.equal(find(dues, "2026-10", A1, A4), 70000);
});

test("a merge is clamped to what is still owed", () => {
  const settlements = [{ fromMemberId: A1, toMemberId: A2, amountMinor: 40000, allocations: [{ periodKey: "2026-09", amountMinor: 40000 }], settledAt: OCT }];
  const plan = dues$.planMerge({ dues: build(september, settlements), fromMemberId: A1, toMemberId: A2, amountMinor: 100000, currentPeriodKey: "2026-10" });
  assert.equal(plan.amountMinor, 60000);
  assert.equal(dues$.planMerge({ dues: build(september), fromMemberId: A2, toMemberId: A1, currentPeriodKey: "2026-10" }), null);
});

test("by person: both directions kept, never silently netted", () => {
  const expenses = [...september, { date: OCT, paidBy: A3, shares: { [A2]: 10000, [A3]: 10000 } }];
  const [withA2] = dues$.byCounterparty(build(expenses), A3);
  assert.equal(withA2.memberId, A2);
  assert.equal(withA2.iOweMinor, 100000);
  assert.equal(withA2.owedToMeMinor, 10000);

  const previousOnly = dues$.byCounterparty(build(expenses), A3, { before: "2026-10" });
  assert.equal(previousOnly[0].owedToMeMinor, 0, "October is not a previous due in October");
});

test("a settlement without allocations belongs to the month it was paid in", () => {
  const dues = build(september, [{ fromMemberId: A1, toMemberId: A2, amountMinor: 100000, settledAt: new Date("2026-09-28T06:00:00Z") }]);
  assert.equal(find(dues, "2026-09", A1, A2), 0);
});

test("cycle rules: legacy groups keep the lock, continuous ones close by date", () => {
  const options = { graceDays: 3, timeZone: TZ };
  assert.equal(dues$.cycleOf({}), "CONTINUOUS");
  assert.equal(dues$.usesMonthLock({}), true, "groups created before cycles keep the lock");
  assert.equal(dues$.usesMonthLock({ balanceCycle: "MONTHLY" }), true);
  assert.equal(dues$.usesMonthLock({ balanceCycle: "CONTINUOUS" }), false);

  const trip = { balanceCycle: "CONTINUOUS", endDate: new Date("2026-10-05T00:00:00Z"), closedAt: null };
  assert.equal(dues$.isClosed(trip, new Date("2026-10-08T12:00:00Z"), options), false, "still inside the grace");
  assert.equal(dues$.isClosed(trip, new Date("2026-10-09T12:00:00Z"), options), true);
  assert.equal(dues$.isClosed({ ...trip, endDate: null }, new Date("2030-01-01"), options), false);
  assert.equal(dues$.isClosed({ ...trip, closedAt: new Date() }, new Date("2026-09-30"), options), true);
  assert.equal(dues$.isClosed({ balanceCycle: "MONTHLY", closedAt: new Date() }, new Date(), options), false);
});

test("property: any mix of expenses, payments, offsets and merges stays consistent", () => {
  // Deterministic PRNG so a failure reproduces.
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const members = [A1, A2, A3, A4];
  const months = ["2026-07", "2026-08", "2026-09", "2026-10"];

  for (let round = 0; round < 60; round += 1) {
    const expenses = [];
    let settlements = [];

    for (let step = 0; step < 30; step += 1) {
      const current = pick(months);
      const roll = rand();

      if (roll < 0.5) {
        const shares = {};
        for (const member of members) if (rand() < 0.7) shares[member] = 100 + Math.floor(rand() * 5000);
        if (Object.keys(shares).length === 0) continue;
        expenses.push({ date: new Date(`${current}-12T06:00:00Z`), paidBy: pick(members), shares });
        continue;
      }

      const dues = build(expenses, settlements);
      const a = pick(members);
      const b = pick(members.filter((m) => m !== a));

      if (roll < 0.75) {
        const amountMinor = 1 + Math.floor(rand() * 8000);
        const allocations = dues$.allocatePayment({ dues, fromMemberId: a, toMemberId: b, amountMinor, currentPeriodKey: current });
        settlements.push({ fromMemberId: a, toMemberId: b, amountMinor, allocations, settledAt: new Date() });
      } else if (roll < 0.88) {
        const plan = dues$.planOffset({ dues, aMemberId: a, bMemberId: b });
        if (plan) {
          settlements = settlements.concat(
            pairRows(
              { fromMemberId: a, toMemberId: b, amountMinor: plan.amountMinor, allocations: plan.aToB },
              { fromMemberId: b, toMemberId: a, amountMinor: plan.amountMinor, allocations: plan.bToA }
            )
          );
        }
      } else {
        const plan = dues$.planMerge({ dues, fromMemberId: a, toMemberId: b, currentPeriodKey: current });
        if (plan) {
          settlements = settlements.concat(
            pairRows(
              { fromMemberId: a, toMemberId: b, amountMinor: plan.amountMinor, allocations: plan.clearing },
              { fromMemberId: b, toMemberId: a, amountMinor: plan.amountMinor, allocations: plan.carrying }
            )
          );
        }
      }

      for (const row of settlements) {
        if (row.allocations?.length) {
          assert.equal(row.allocations.reduce((s, x) => s + x.amountMinor, 0), row.amountMinor, "allocations must sum to the payment");
        }
      }
    }

    assertConsistent(expenses, settlements);
  }
});
