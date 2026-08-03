const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitEqually,
  splitByWeights,
  splitExactly,
  normalizeSplitValues,
  calculateShares,
  assertSharesBalance,
} = require("../src/utils/splitCalculator");
const { SPLIT_TYPES, ERROR_CODES, LIMITS } = require("../src/constants");

/**
 * The invariant every one of these tests is really checking is the same one:
 * Σ shares === amountMinor, exactly. A split that misses by one paise breaks the
 * zero-sum balance guarantee for the whole group from that expense onwards.
 */

// Ids are compared as strings and ties break on them, so fixed sortable ids keep
// the expectations readable.
const [A, B, C, D] = ["aaa1", "bbb2", "ccc3", "ddd4"];

const totalOf = (shares) => shares.reduce((sum, share) => sum + share.amountMinor, 0);

const shareFor = (shares, memberId) =>
  shares.find((share) => share.memberId === memberId)?.amountMinor;

const valuesOf = (pairs) => pairs.map(([memberId, value]) => ({ memberId, value }));

// ---------------------------------------------------------------------------
// Equal split
// ---------------------------------------------------------------------------

test("equal split divides evenly when there is no remainder", () => {
  const shares = splitEqually(900, [A, B, C]);

  assert.deepEqual(shares, [
    { memberId: A, amountMinor: 300 },
    { memberId: B, amountMinor: 300 },
    { memberId: C, amountMinor: 300 },
  ]);
});

test("equal split hands the leftover paise to the first ids, and still sums exactly", () => {
  // ₹10 three ways: 333.33 each leaves one paise that has to go somewhere.
  const shares = splitEqually(1000, [C, A, B]);

  assert.equal(totalOf(shares), 1000);
  assert.equal(shareFor(shares, A), 334);
  assert.equal(shareFor(shares, B), 333);
  assert.equal(shareFor(shares, C), 333);
});

test("equal split ignores the order participants were sent in", () => {
  const forward = splitEqually(1000, [A, B, C]);
  const reversed = splitEqually(1000, [C, B, A]);

  assert.deepEqual(forward, reversed);
});

test("equal split sums exactly for every amount and party size in a wide sweep", () => {
  const ids = [A, B, C, D, "eee5", "fff6", "ggg7"];

  for (let count = 1; count <= ids.length; count += 1) {
    for (let amountMinor = 1; amountMinor <= 400; amountMinor += 1) {
      const shares = splitEqually(amountMinor, ids.slice(0, count));

      assert.equal(totalOf(shares), amountMinor);
      assert.equal(shares.length, count);
      // Largest remainder never spreads the shares by more than a single unit.
      const amounts = shares.map((share) => share.amountMinor);
      assert.ok(Math.max(...amounts) - Math.min(...amounts) <= 1);
    }
  }
});

test("equal split rejects a zero or negative amount", () => {
  assert.throws(() => splitEqually(0, [A]), { code: ERROR_CODES.INVALID_AMOUNT });
  assert.throws(() => splitEqually(-100, [A]), { code: ERROR_CODES.INVALID_AMOUNT });
});

test("equal split rejects a non-integer amount", () => {
  assert.throws(() => splitEqually(10.5, [A, B]), { code: ERROR_CODES.INVALID_AMOUNT });
});

test("equal split rejects an empty or duplicated participant list", () => {
  assert.throws(() => splitEqually(1000, []), { code: ERROR_CODES.INVALID_PARTICIPANTS });
  assert.throws(() => splitEqually(1000, [A, A, B]), { code: ERROR_CODES.INVALID_PARTICIPANTS });
});

// ---------------------------------------------------------------------------
// Weighted split (the engine behind SHARES and PERCENTAGE)
// ---------------------------------------------------------------------------

test("weighted split allocates in proportion to the weights", () => {
  const shares = splitByWeights(1000, [A, B, C], new Map([[A, 2], [B, 1], [C, 1]]));

  assert.equal(shareFor(shares, A), 500);
  assert.equal(shareFor(shares, B), 250);
  assert.equal(shareFor(shares, C), 250);
  assert.equal(totalOf(shares), 1000);
});

test("weighted split gives the leftover to the largest discarded fraction", () => {
  // 100 split 1:1:1 is 33.33… each; the three fractions tie, so ids break it.
  const shares = splitByWeights(100, [A, B, C], new Map([[A, 1], [B, 1], [C, 1]]));

  assert.equal(totalOf(shares), 100);
  assert.equal(shareFor(shares, A), 34);

  // 100 split 1:1:2 gives 25/25/50 exactly — nothing left to hand out.
  const clean = splitByWeights(100, [A, B, C], new Map([[A, 1], [B, 1], [C, 2]]));
  assert.deepEqual(clean.map((share) => share.amountMinor), [25, 25, 50]);
});

test("weighted split is exact across a sweep of awkward weights", () => {
  const ids = [A, B, C, D];

  for (const weights of [[1, 2, 3, 4], [7, 1, 1, 1], [3, 3, 3, 1], [1, 1, 1, 997]]) {
    const weightMap = new Map(ids.map((memberId, index) => [memberId, weights[index]]));

    for (let amountMinor = 1; amountMinor <= 500; amountMinor += 1) {
      assert.equal(totalOf(splitByWeights(amountMinor, ids, weightMap)), amountMinor);
    }
  }
});

test("equal split is exactly the weighted split with unit weights", () => {
  const ids = [A, B, C, D];
  const unit = new Map(ids.map((memberId) => [memberId, 1]));

  for (let amountMinor = 1; amountMinor <= 300; amountMinor += 1) {
    assert.deepEqual(splitEqually(amountMinor, ids), splitByWeights(amountMinor, ids, unit));
  }
});

test("weighted split rejects weights that are absent, fractional or all zero", () => {
  assert.throws(() => splitByWeights(1000, [A, B], new Map([[A, 1]])), {
    code: ERROR_CODES.INVALID_SPLIT,
  });
  assert.throws(() => splitByWeights(1000, [A, B], new Map([[A, 1.5], [B, 1]])), {
    code: ERROR_CODES.INVALID_SPLIT,
  });
  assert.throws(() => splitByWeights(1000, [A, B], new Map([[A, 0], [B, 0]])), {
    code: ERROR_CODES.INVALID_SPLIT,
  });
});

// ---------------------------------------------------------------------------
// Exact split
// ---------------------------------------------------------------------------

test("exact split keeps the amounts it was given", () => {
  const shares = splitExactly(1000, [A, B], new Map([[A, 700], [B, 300]]), "INR");

  assert.equal(shareFor(shares, A), 700);
  assert.equal(shareFor(shares, B), 300);
});

test("exact split refuses amounts that do not add up, and says by how much", () => {
  assert.throws(
    () => splitExactly(1000, [A, B], new Map([[A, 700], [B, 200]]), "INR"),
    (error) => {
      assert.equal(error.code, ERROR_CODES.INVALID_SPLIT);
      assert.match(error.message, /short by ₹1\.00/);
      return true;
    }
  );

  assert.throws(
    () => splitExactly(1000, [A, B], new Map([[A, 700], [B, 400]]), "INR"),
    (error) => {
      assert.match(error.message, /over by ₹1\.00/);
      return true;
    }
  );
});

test("exact split refuses a zero share", () => {
  assert.throws(() => splitExactly(1000, [A, B], new Map([[A, 1000], [B, 0]]), "INR"), {
    code: ERROR_CODES.INVALID_SPLIT,
  });
});

// ---------------------------------------------------------------------------
// Normalizing client input into stored integers
// ---------------------------------------------------------------------------

test("normalize converts exact amounts to minor units", () => {
  const values = normalizeSplitValues({
    splitType: SPLIT_TYPES.EXACT,
    splitValues: valuesOf([[A, 250.5], [B, "749.50"]]),
    currency: "INR",
  });

  assert.deepEqual(values, [
    { memberId: A, value: 25050 },
    { memberId: B, value: 74950 },
  ]);
});

test("normalize converts percentages to centipercent", () => {
  const values = normalizeSplitValues({
    splitType: SPLIT_TYPES.PERCENTAGE,
    splitValues: valuesOf([[A, 33.33], [B, 66.67]]),
    currency: "INR",
  });

  assert.deepEqual(values, [
    { memberId: A, value: 3333 },
    { memberId: B, value: 6667 },
  ]);
});

test("normalize rejects percentages with more than two decimals or out of range", () => {
  const reject = (value) =>
    assert.throws(
      () =>
        normalizeSplitValues({
          splitType: SPLIT_TYPES.PERCENTAGE,
          splitValues: valuesOf([[A, value]]),
          currency: "INR",
        }),
      { code: ERROR_CODES.INVALID_SPLIT }
    );

  reject(33.333);
  reject(0);
  reject(-10);
  reject(100.01);
});

test("normalize rejects share weights that are not whole numbers in range", () => {
  const reject = (value) =>
    assert.throws(
      () =>
        normalizeSplitValues({
          splitType: SPLIT_TYPES.SHARES,
          splitValues: valuesOf([[A, value]]),
          currency: "INR",
        }),
      { code: ERROR_CODES.INVALID_SPLIT }
    );

  reject(0);
  reject(1.5);
  reject(-2);
  reject(LIMITS.MAX_SHARE_WEIGHT + 1);
});

test("normalize returns nothing for an equal split", () => {
  assert.deepEqual(
    normalizeSplitValues({ splitType: SPLIT_TYPES.EQUAL, splitValues: undefined, currency: "INR" }),
    []
  );
});

// ---------------------------------------------------------------------------
// calculateShares — the dispatch the service actually calls
// ---------------------------------------------------------------------------

const calc = (splitType, amountMinor, participantIds, pairs) =>
  calculateShares({
    splitType,
    amountMinor,
    participantIds,
    splitValues: pairs === undefined ? [] : valuesOf(pairs),
    currency: "INR",
  });

test("percentages that total 100 produce shares that total the amount", () => {
  // 33.33 / 33.33 / 33.34 of ₹10 — the classic case where naive rounding loses a paise.
  const shares = calc(SPLIT_TYPES.PERCENTAGE, 1000, [A, B, C], [
    [A, 3333],
    [B, 3333],
    [C, 3334],
  ]);

  assert.equal(totalOf(shares), 1000);
  assert.equal(shareFor(shares, C), 334);
});

test("percentages that do not total 100 are refused with the running total", () => {
  assert.throws(
    () => calc(SPLIT_TYPES.PERCENTAGE, 1000, [A, B], [[A, 5000], [B, 4000]]),
    (error) => {
      assert.equal(error.code, ERROR_CODES.INVALID_SPLIT);
      assert.match(error.message, /90\.00%/);
      return true;
    }
  );
});

test("a shares split weights the people who consumed more", () => {
  const shares = calc(SPLIT_TYPES.SHARES, 40000, [A, B, C], [[A, 2], [B, 1], [C, 1]]);

  assert.equal(shareFor(shares, A), 20000);
  assert.equal(shareFor(shares, B), 10000);
  assert.equal(shareFor(shares, C), 10000);
});

test("an exact split routes through and balances", () => {
  const shares = calc(SPLIT_TYPES.EXACT, 100000, [A, B], [[A, 60000], [B, 40000]]);

  assert.equal(totalOf(shares), 100000);
  assert.equal(shareFor(shares, A), 60000);
});

test("a split value for someone who is not a participant is refused", () => {
  assert.throws(() => calc(SPLIT_TYPES.SHARES, 1000, [A, B], [[A, 1], [B, 1], [C, 1]]), {
    code: ERROR_CODES.INVALID_SPLIT,
  });
});

test("a participant with no split value is refused", () => {
  assert.throws(() => calc(SPLIT_TYPES.SHARES, 1000, [A, B, C], [[A, 1], [B, 1]]), {
    code: ERROR_CODES.INVALID_SPLIT,
  });
});

test("a duplicated participant in the split values is refused", () => {
  assert.throws(() => calc(SPLIT_TYPES.SHARES, 1000, [A, B], [[A, 1], [A, 2]]), {
    code: ERROR_CODES.INVALID_SPLIT,
  });
});

test("a non-equal split with no values at all is refused", () => {
  assert.throws(() => calc(SPLIT_TYPES.PERCENTAGE, 1000, [A, B]), {
    code: ERROR_CODES.INVALID_SPLIT,
  });
});

test("an unknown split type is refused", () => {
  assert.throws(() => calc("WHATEVER", 1000, [A, B]), { code: ERROR_CODES.VALIDATION_ERROR });
});

test("equal is the default when no split type is given", () => {
  assert.deepEqual(
    calculateShares({ amountMinor: 1000, participantIds: [A, B, C] }),
    splitEqually(1000, [A, B, C])
  );
});

// ---------------------------------------------------------------------------
// The post-condition itself
// ---------------------------------------------------------------------------

test("assertSharesBalance accepts a balanced set and rejects a drifted one", () => {
  assert.equal(assertSharesBalance([{ memberId: A, amountMinor: 1000 }], 1000), true);

  assert.throws(() => assertSharesBalance([{ memberId: A, amountMinor: 999 }], 1000), {
    code: ERROR_CODES.INTERNAL_ERROR,
  });
});
