const test = require("node:test");
const assert = require("node:assert/strict");

const { minimizeTransactions, verifyTransfers } = require("../src/utils/settlementOptimizer");
const { ERROR_CODES } = require("../src/constants");

/**
 * The optimizer's contract, from docs/05-ALGORITHMS.md §4: it terminates, it uses at
 * most N−1 transfers, applying the plan zeroes every balance, and the same balances
 * always yield the same plan. The last one matters because two people looking at the
 * same group must be told to make the same payment.
 */

const balances = (pairs) => pairs.map(([memberId, netMinor]) => ({ memberId, netMinor }));

const nonZeroCount = (rows) => rows.filter((row) => row.netMinor !== 0).length;

/** A deterministic PRNG, so a failing sweep can be reproduced from the seed. */
const makeRandom = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

test("nothing to settle produces no transfers", () => {
  assert.deepEqual(minimizeTransactions([]), []);
  assert.deepEqual(minimizeTransactions(balances([["a", 0], ["b", 0]])), []);
});

test("one debtor and one creditor is a single transfer", () => {
  const transfers = minimizeTransactions(balances([["a", -5000], ["b", 5000]]));

  assert.deepEqual(transfers, [{ fromMemberId: "a", toMemberId: "b", amountMinor: 5000 }]);
});

test("members already at zero never appear in the plan", () => {
  const rows = balances([["a", -5000], ["b", 5000], ["c", 0]]);
  const transfers = minimizeTransactions(rows);

  assert.equal(transfers.length, 1);
  assert.ok(
    transfers.every(({ fromMemberId, toMemberId }) => fromMemberId !== "c" && toMemberId !== "c")
  );
});

test("an exact match is settled directly rather than routed through a third party", () => {
  // b owes exactly what c is owed, so they should pay each other.
  const rows = balances([["a", -3000], ["b", -5000], ["c", 5000], ["d", 3000]]);
  const transfers = minimizeTransactions(rows);

  assert.equal(transfers.length, 2);
  assert.ok(verifyTransfers(rows, transfers));
  assert.ok(
    transfers.some(
      (transfer) =>
        transfer.fromMemberId === "b" && transfer.toMemberId === "c" && transfer.amountMinor === 5000
    )
  );
});

test("the greedy stage clears a chain in at most N-1 transfers", () => {
  const rows = balances([["a", -6000], ["b", -1000], ["c", 2000], ["d", 5000]]);
  const transfers = minimizeTransactions(rows);

  assert.ok(verifyTransfers(rows, transfers));
  assert.ok(transfers.length <= nonZeroCount(rows) - 1);
});

test("transfers come back largest first", () => {
  const rows = balances([["a", -10000], ["b", -100], ["c", 10100]]);
  const amounts = minimizeTransactions(rows).map((transfer) => transfer.amountMinor);

  assert.deepEqual(amounts, [...amounts].sort((x, y) => y - x));
});

test("the same balances always produce the same plan, whatever order they arrive in", () => {
  const rows = balances([["a", -2500], ["b", -1500], ["c", 3000], ["d", 1000]]);
  const shuffled = [rows[2], rows[0], rows[3], rows[1]];

  assert.deepEqual(minimizeTransactions(rows), minimizeTransactions(shuffled));
});

test("every transfer is a positive integer amount", () => {
  const rows = balances([["a", -3333], ["b", -3333], ["c", -3334], ["d", 10000]]);

  for (const { amountMinor } of minimizeTransactions(rows)) {
    assert.ok(Number.isInteger(amountMinor), "transfer amounts must be integers");
    assert.ok(amountMinor > 0, "a transfer of zero or less is not a payment");
  }
});

test("a non-integer balance is refused rather than rounded", () => {
  assert.throws(() => minimizeTransactions(balances([["a", -10.5], ["b", 10.5]])), {
    code: ERROR_CODES.INVALID_AMOUNT,
  });
});

test("randomised zero-sum balances always settle within the N-1 bound", () => {
  const random = makeRandom(20260803);

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const count = 2 + Math.floor(random() * 9); // 2–10 members
    const rows = [];
    let running = 0;

    for (let index = 0; index < count - 1; index += 1) {
      // Deliberately includes zeros and repeated magnitudes so the exact-match
      // pre-pass and the greedy stage both get exercised.
      const net = Math.floor(random() * 20000) - 10000;
      rows.push({ memberId: `m${index}`, netMinor: net });
      running += net;
    }

    // The last member absorbs the remainder, which is what makes the set zero-sum.
    rows.push({ memberId: `m${count - 1}`, netMinor: -running });

    const transfers = minimizeTransactions(rows);

    assert.ok(verifyTransfers(rows, transfers), `plan did not settle: ${JSON.stringify(rows)}`);

    const active = nonZeroCount(rows);
    if (active > 0) {
      assert.ok(
        transfers.length <= active - 1,
        `used ${transfers.length} transfers for ${active} members`
      );
    }
  }
});

test("verifyTransfers rejects a plan that does not clear the balances", () => {
  const rows = balances([["a", -5000], ["b", 5000]]);

  assert.equal(verifyTransfers(rows, []), false);
  assert.equal(
    verifyTransfers(rows, [{ fromMemberId: "a", toMemberId: "b", amountMinor: 4000 }]),
    false
  );
  assert.equal(
    verifyTransfers(rows, [{ fromMemberId: "a", toMemberId: "b", amountMinor: 5000 }]),
    true
  );
});
