const test = require("node:test");
const assert = require("node:assert/strict");

const {
  coalesceBy,
  remapExpense,
  remapSettlement,
  assertExpenseIntact,
} = require("../src/utils/memberMerge");
const { splitEqually } = require("../src/utils/splitCalculator");

/**
 * A merge exists to repair identity, not to move money. Every test here is really
 * asking the same question: after folding one member into another, does the group
 * still owe exactly what it owed before?
 */

const DUPE = "aaa1"; // the accidental second identity
const REAL = "bbb2"; // the person it belongs to
const OTHER = "ccc3";

const expenseWith = (overrides = {}) => ({
  _id: "exp1",
  amountMinor: 90000,
  paidBy: OTHER,
  createdByMemberId: OTHER,
  deletedByMemberId: null,
  splitType: "EQUAL",
  shares: [
    { memberId: DUPE, amountMinor: 30000 },
    { memberId: REAL, amountMinor: 30000 },
    { memberId: OTHER, amountMinor: 30000 },
  ],
  splitValues: [],
  ...overrides,
});

const totalOf = (shares) => shares.reduce((sum, share) => sum + share.amountMinor, 0);

// ---------------------------------------------------------------------------
// coalesceBy
// ---------------------------------------------------------------------------

test("coalesce rewrites the id when there is no collision", () => {
  const rows = [
    { memberId: DUPE, amountMinor: 500 },
    { memberId: OTHER, amountMinor: 500 },
  ];

  assert.deepEqual(coalesceBy(rows, "amountMinor", DUPE, REAL), [
    { memberId: REAL, amountMinor: 500 },
    { memberId: OTHER, amountMinor: 500 },
  ]);
});

test("coalesce sums the two rows when the same person appears twice", () => {
  const rows = [
    { memberId: DUPE, amountMinor: 300 },
    { memberId: REAL, amountMinor: 200 },
    { memberId: OTHER, amountMinor: 500 },
  ];

  const merged = coalesceBy(rows, "amountMinor", DUPE, REAL);

  assert.equal(merged.length, 2, "the duplicate should not survive as its own row");
  assert.equal(merged.find((row) => row.memberId === REAL).amountMinor, 500);
  assert.equal(totalOf(merged), totalOf(rows), "the total must not move");
});

test("coalesce keeps the surviving row in the position the duplicate held", () => {
  // Order is stable so a merged expense does not reshuffle in the UI.
  const rows = [
    { memberId: DUPE, amountMinor: 100 },
    { memberId: OTHER, amountMinor: 100 },
    { memberId: REAL, amountMinor: 100 },
  ];

  assert.deepEqual(
    coalesceBy(rows, "amountMinor", DUPE, REAL).map((row) => row.memberId),
    [REAL, OTHER]
  );
});

test("coalesce works on the split-value field too", () => {
  const rows = [
    { memberId: DUPE, value: 2500 },
    { memberId: REAL, value: 2500 },
    { memberId: OTHER, value: 5000 },
  ];

  const merged = coalesceBy(rows, "value", DUPE, REAL);

  // Percentages are centipercent; 25% + 25% is 50%, and the total is still 100%.
  assert.equal(merged.find((row) => row.memberId === REAL).value, 5000);
  assert.equal(
    merged.reduce((sum, row) => sum + row.value, 0),
    10000
  );
});

// ---------------------------------------------------------------------------
// remapExpense
// ---------------------------------------------------------------------------

test("an expense that never involved the duplicate is left alone", () => {
  const expense = expenseWith({
    shares: [
      { memberId: REAL, amountMinor: 45000 },
      { memberId: OTHER, amountMinor: 45000 },
    ],
  });

  assert.deepEqual(remapExpense(expense, DUPE, REAL), {
    changed: false,
    resplit: false,
    patch: {},
  });
});

test("an equal split is re-divided between the people who were really there", () => {
  // ₹900 "three ways" was only ever eaten by two people, because DUPE is REAL's
  // second device. Moving DUPE's ₹300 onto REAL would bill REAL ₹600 for half a
  // dinner — the phantom's share, charged to a real person.
  const expense = expenseWith();
  const { changed, resplit, patch } = remapExpense(expense, DUPE, REAL);

  assert.equal(changed, true);
  assert.equal(resplit, true);
  assert.equal(patch.shares.length, 2);
  assert.equal(patch.shares.find((share) => share.memberId === REAL).amountMinor, 45000);
  assert.equal(patch.shares.find((share) => share.memberId === OTHER).amountMinor, 45000);
  assert.equal(totalOf(patch.shares), expense.amountMinor);
});

test("re-dividing keeps the remainder rule, so the total is still exact", () => {
  // ₹10 three ways is 333/333/334; two ways is 500/500. Neither may lose a paisa.
  const expense = expenseWith({
    amountMinor: 1000,
    shares: [
      { memberId: DUPE, amountMinor: 334 },
      { memberId: REAL, amountMinor: 333 },
      { memberId: OTHER, amountMinor: 333 },
    ],
  });

  const { patch } = remapExpense(expense, DUPE, REAL);

  assert.equal(totalOf(patch.shares), 1000);
  assert.deepEqual(
    patch.shares.map((share) => share.amountMinor).sort(),
    [500, 500]
  );
});

test("an expense the duplicate was not part of is only reassigned, never re-divided", () => {
  // DUPE only paid; the three participants are still three real people.
  const expense = expenseWith({
    paidBy: DUPE,
    shares: [
      { memberId: REAL, amountMinor: 30000 },
      { memberId: OTHER, amountMinor: 30000 },
      { memberId: "ddd4", amountMinor: 30000 },
    ],
  });

  const { resplit, patch } = remapExpense(expense, DUPE, REAL);

  assert.equal(resplit, false);
  assert.equal(patch.paidBy, REAL);
  assert.deepEqual(
    patch.shares.map((share) => share.amountMinor),
    [30000, 30000, 30000]
  );
});

test("payer, author and deleter references all move", () => {
  const expense = expenseWith({
    paidBy: DUPE,
    createdByMemberId: DUPE,
    deletedByMemberId: DUPE,
  });

  const { patch } = remapExpense(expense, DUPE, REAL);

  assert.equal(patch.paidBy, REAL);
  assert.equal(patch.createdByMemberId, REAL);
  assert.equal(patch.deletedByMemberId, REAL);
});

test("a deleter reference is only set when there was one", () => {
  const { patch } = remapExpense(expenseWith({ paidBy: DUPE }), DUPE, REAL);
  assert.equal("deletedByMemberId" in patch, false);
});

test("an expense the duplicate only paid for keeps its shares untouched", () => {
  const expense = expenseWith({
    paidBy: DUPE,
    shares: [
      { memberId: REAL, amountMinor: 45000 },
      { memberId: OTHER, amountMinor: 45000 },
    ],
  });

  const { patch } = remapExpense(expense, DUPE, REAL);

  assert.equal(patch.paidBy, REAL);
  assert.equal(totalOf(patch.shares), 90000);
});

test("exact amounts are summed, not re-divided — they were typed on purpose", () => {
  const expense = expenseWith({
    splitType: "EXACT",
    amountMinor: 10000,
    shares: [
      { memberId: DUPE, amountMinor: 2000 },
      { memberId: REAL, amountMinor: 5000 },
      { memberId: OTHER, amountMinor: 3000 },
    ],
    splitValues: [
      { memberId: DUPE, value: 2000 },
      { memberId: REAL, value: 5000 },
      { memberId: OTHER, value: 3000 },
    ],
  });

  const { patch } = remapExpense(expense, DUPE, REAL);

  // One person held two rows, so they owe the sum — ₹70, not an equal ₹50.
  assert.equal(patch.shares.find((share) => share.memberId === REAL).amountMinor, 7000);
  assert.equal(patch.shares.find((share) => share.memberId === OTHER).amountMinor, 3000);
  assert.equal(totalOf(patch.shares), 10000);
});

test("percentages are summed and still total exactly 100%", () => {
  const expense = expenseWith({
    splitType: "PERCENTAGE",
    amountMinor: 10000,
    shares: [
      { memberId: DUPE, amountMinor: 2500 },
      { memberId: REAL, amountMinor: 2500 },
      { memberId: OTHER, amountMinor: 5000 },
    ],
    splitValues: [
      { memberId: DUPE, value: 2500 },
      { memberId: REAL, value: 2500 },
      { memberId: OTHER, value: 5000 },
    ],
  });

  const { patch } = remapExpense(expense, DUPE, REAL);

  assert.equal(
    patch.splitValues.reduce((sum, row) => sum + row.value, 0),
    10000,
    "still 100%"
  );
  assert.equal(patch.shares.find((share) => share.memberId === REAL).amountMinor, 5000);
  assert.equal(totalOf(patch.shares), 10000);
});

test("share weights are summed, because carrying two portions is a stated intent", () => {
  const expense = expenseWith({
    splitType: "SHARES",
    amountMinor: 40000,
    shares: [
      { memberId: DUPE, amountMinor: 10000 },
      { memberId: REAL, amountMinor: 10000 },
      { memberId: OTHER, amountMinor: 20000 },
    ],
    splitValues: [
      { memberId: DUPE, value: 1 },
      { memberId: REAL, value: 1 },
      { memberId: OTHER, value: 2 },
    ],
  });

  const { patch } = remapExpense(expense, DUPE, REAL);

  assert.equal(patch.splitValues.find((row) => row.memberId === REAL).value, 2);
  assert.equal(patch.splitValues.length, 2);
  // 2 weights of 4 — the shares follow the weights, and still add up.
  assert.equal(patch.shares.find((share) => share.memberId === REAL).amountMinor, 20000);
  assert.equal(totalOf(patch.shares), 40000);
});

test("an expense split only between the two duplicates collapses to one share", () => {
  const expense = expenseWith({
    amountMinor: 1000,
    paidBy: DUPE,
    shares: [
      { memberId: DUPE, amountMinor: 334 },
      { memberId: REAL, amountMinor: 666 },
    ],
  });

  const { patch } = remapExpense(expense, DUPE, REAL);

  assert.deepEqual(patch.shares, [{ memberId: REAL, amountMinor: 1000 }]);
  assert.equal(patch.paidBy, REAL);
});

// ---------------------------------------------------------------------------
// remapSettlement
// ---------------------------------------------------------------------------

test("a settlement not involving the duplicate is untouched", () => {
  const settlement = { fromMemberId: REAL, toMemberId: OTHER, recordedByMemberId: OTHER };
  assert.deepEqual(remapSettlement(settlement, DUPE, REAL), { action: "none" });
});

test("a settlement with a third party is reassigned", () => {
  const settlement = { fromMemberId: DUPE, toMemberId: OTHER, recordedByMemberId: DUPE };
  const result = remapSettlement(settlement, DUPE, REAL);

  assert.equal(result.action, "update");
  assert.deepEqual(result.patch, {
    fromMemberId: REAL,
    toMemberId: OTHER,
    recordedByMemberId: REAL,
  });
});

test("a payment between the two duplicates is dropped, not left pointing at itself", () => {
  // This is the payment the app suggested when it thought one person was two.
  assert.deepEqual(remapSettlement({ fromMemberId: DUPE, toMemberId: REAL }, DUPE, REAL), {
    action: "drop",
  });
  assert.deepEqual(remapSettlement({ fromMemberId: REAL, toMemberId: DUPE }, DUPE, REAL), {
    action: "drop",
  });
});

test("recordedBy alone is enough to need an update", () => {
  const settlement = { fromMemberId: REAL, toMemberId: OTHER, recordedByMemberId: DUPE };
  const result = remapSettlement(settlement, DUPE, REAL);

  assert.equal(result.action, "update");
  assert.equal(result.patch.recordedByMemberId, REAL);
});

// ---------------------------------------------------------------------------
// The guard that runs before anything is written
// ---------------------------------------------------------------------------

test("the integrity check accepts a correct merge", () => {
  const expense = expenseWith();
  const { patch } = remapExpense(expense, DUPE, REAL);
  assert.equal(assertExpenseIntact(expense, patch), true);
});

test("the integrity check refuses a merge whose shares stopped adding up", () => {
  const expense = expenseWith();

  assert.throws(
    () => assertExpenseIntact(expense, { shares: [{ memberId: REAL, amountMinor: 89999 }] }),
    /would unbalance expense/
  );
});

test("the integrity check refuses a merge that invented a participant", () => {
  const expense = expenseWith({
    amountMinor: 1000,
    shares: [{ memberId: DUPE, amountMinor: 1000 }],
  });

  assert.throws(
    () =>
      assertExpenseIntact(expense, {
        shares: [
          { memberId: REAL, amountMinor: 500 },
          { memberId: OTHER, amountMinor: 500 },
        ],
      }),
    /added a participant/
  );
});

// ---------------------------------------------------------------------------
// The property that matters most
// ---------------------------------------------------------------------------

test("the expense total never moves, across a sweep of amounts and party sizes", () => {
  const members = [DUPE, REAL, OTHER, "ddd4"];

  for (let amountMinor = 1; amountMinor <= 600; amountMinor += 1) {
    for (let participants = 1; participants <= members.length; participants += 1) {
      const ids = members.slice(0, participants);
      const base = Math.floor(amountMinor / participants);
      const shares = ids.map((memberId, index) => ({
        memberId,
        amountMinor: base + (index < amountMinor - base * participants ? 1 : 0),
      }));

      const expense = expenseWith({ amountMinor, shares, paidBy: ids[0] });
      const { changed, patch } = remapExpense(expense, DUPE, REAL);

      if (!changed) continue;

      assert.equal(
        totalOf(patch.shares),
        amountMinor,
        `total moved for ${amountMinor} across ${participants}`
      );
      assertExpenseIntact(expense, patch);

      // Nobody is listed twice after the merge.
      const seen = new Set(patch.shares.map((share) => share.memberId));
      assert.equal(seen.size, patch.shares.length);
      assert.equal(seen.has(DUPE), false, "the duplicate should be gone");

      // No share drifts more than a paisa from an even division of what is left.
      const even = Math.floor(amountMinor / patch.shares.length);
      for (const share of patch.shares) {
        assert.ok(
          Math.abs(share.amountMinor - even) <= 1,
          `share ${share.amountMinor} is not an even division of ${amountMinor}`
        );
      }
    }
  }
});

test("a merged equal split matches what the expense would have been without the duplicate", () => {
  // The strongest statement of the rule: repair the past, do not patch it.
  const members = [DUPE, REAL, OTHER, "ddd4"];

  for (let amountMinor = 1; amountMinor <= 400; amountMinor += 1) {
    const withDuplicate = expenseWith({
      amountMinor,
      shares: members.map((memberId) => ({ memberId, amountMinor: 0 })),
    });

    const merged = remapExpense(withDuplicate, DUPE, REAL).patch.shares;

    // What the split calculator produces for the three people who were really
    // there — i.e. the expense as it would have been entered without the phantom.
    const control = splitEqually(amountMinor, [REAL, OTHER, "ddd4"]);

    assert.deepEqual(merged, control, `diverged at ${amountMinor}`);
  }
});
