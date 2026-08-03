const { assertMinor } = require("./money");

/**
 * Turns a set of net balances into the smallest practical set of payments that
 * clears every debt.
 *
 * Naive settlement is O(N²) payments — with 8 people on a weekend trip that is up
 * to 28 separate transfers, which nobody actually does. Collapsing that list is the
 * whole point of the feature.
 *
 * Finding the true minimum is NP-hard (it reduces to set-partition: the optimum is
 * N − k where k is the largest number of disjoint zero-sum subgroups). We use the
 * standard two-stage approach:
 *
 *   Stage 1  exact matches  — a debtor whose debt equals a creditor's credit is a
 *                             guaranteed-optimal single transfer that zeroes two
 *                             people at once, and it reads naturally to users
 *                             ("pay exactly the person you owe").
 *   Stage 2  greedy max/max — repeatedly settle the largest debt against the largest
 *                             credit. Each transfer zeroes at least one party, so the
 *                             loop runs at most N−1 times.
 *
 * Guarantees: terminates, ≤ N−1 transfers, applying all transfers zeroes every
 * balance, value is conserved, all arithmetic is integer minor units, and ties break
 * on member id so the same balances always yield the same plan.
 *
 * See docs/05-ALGORITHMS.md §4.
 */

/** Max-heap ordered by amount desc, then memberId asc for deterministic ties. */
class MaxHeap {
  constructor(items = []) {
    this.items = [...items];
    for (let i = (this.items.length >> 1) - 1; i >= 0; i -= 1) this.#sinkDown(i);
  }

  get size() {
    return this.items.length;
  }

  peek() {
    return this.items[0];
  }

  push(item) {
    this.items.push(item);
    this.#bubbleUp(this.items.length - 1);
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.#sinkDown(0);
    }
    return top;
  }

  static #isHigher(a, b) {
    if (a.amount !== b.amount) return a.amount > b.amount;
    return a.memberId < b.memberId;
  }

  #bubbleUp(start) {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!MaxHeap.#isHigher(this.items[index], this.items[parent])) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  #sinkDown(start) {
    let index = start;
    const { length } = this.items;

    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let highest = index;

      if (left < length && MaxHeap.#isHigher(this.items[left], this.items[highest])) highest = left;
      if (right < length && MaxHeap.#isHigher(this.items[right], this.items[highest])) highest = right;
      if (highest === index) break;

      [this.items[index], this.items[highest]] = [this.items[highest], this.items[index]];
      index = highest;
    }
  }
}

/**
 * @param {Array<{memberId: string, netMinor: number}>} balances — must sum to zero
 * @returns {Array<{fromMemberId: string, toMemberId: string, amountMinor: number}>}
 */
const minimizeTransactions = (balances) => {
  const debtors = [];
  const creditors = [];

  for (const { memberId, netMinor } of balances) {
    assertMinor(netMinor, "Net balance");
    // Members at exactly zero are already settled and never appear in the plan.
    if (netMinor < 0) debtors.push({ memberId: String(memberId), amount: -netMinor });
    else if (netMinor > 0) creditors.push({ memberId: String(memberId), amount: netMinor });
  }

  if (debtors.length === 0 || creditors.length === 0) return [];

  const transfers = [];

  // ---- Stage 1: exact matches -------------------------------------------------
  const creditorsByAmount = new Map();
  for (const creditor of creditors) {
    if (!creditorsByAmount.has(creditor.amount)) creditorsByAmount.set(creditor.amount, []);
    creditorsByAmount.get(creditor.amount).push(creditor);
  }

  const matchedCreditors = new Set();
  const remainingDebtors = [];

  for (const debtor of debtors) {
    const candidates = creditorsByAmount.get(debtor.amount);
    const match = candidates?.find((creditor) => !matchedCreditors.has(creditor));

    if (match) {
      matchedCreditors.add(match);
      transfers.push({
        fromMemberId: debtor.memberId,
        toMemberId: match.memberId,
        amountMinor: debtor.amount,
      });
    } else {
      remainingDebtors.push(debtor);
    }
  }

  const remainingCreditors = creditors.filter((creditor) => !matchedCreditors.has(creditor));

  // ---- Stage 2: greedy largest-against-largest --------------------------------
  const debtorHeap = new MaxHeap(remainingDebtors);
  const creditorHeap = new MaxHeap(remainingCreditors);

  while (debtorHeap.size > 0 && creditorHeap.size > 0) {
    const debtor = debtorHeap.pop();
    const creditor = creditorHeap.pop();
    const amount = Math.min(debtor.amount, creditor.amount);

    transfers.push({
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amountMinor: amount,
    });

    // Whichever side is not fully cleared goes back for another round; at least one
    // of them is now zero, which is the loop's progress guarantee.
    const debtorLeft = debtor.amount - amount;
    const creditorLeft = creditor.amount - amount;
    if (debtorLeft > 0) debtorHeap.push({ ...debtor, amount: debtorLeft });
    if (creditorLeft > 0) creditorHeap.push({ ...creditor, amount: creditorLeft });
  }

  // Largest first — the transfers that matter most appear at the top of the list.
  return transfers.sort(
    (a, b) => b.amountMinor - a.amountMinor || a.fromMemberId.localeCompare(b.fromMemberId)
  );
};

/**
 * Verifies a transfer plan actually settles the balances it was built from.
 * Used by tests and by the property-based check described in docs/03-LLD.md §9.
 */
const verifyTransfers = (balances, transfers) => {
  const residual = new Map(balances.map(({ memberId, netMinor }) => [String(memberId), netMinor]));

  for (const { fromMemberId, toMemberId, amountMinor } of transfers) {
    residual.set(fromMemberId, (residual.get(fromMemberId) ?? 0) + amountMinor);
    residual.set(toMemberId, (residual.get(toMemberId) ?? 0) - amountMinor);
  }

  return [...residual.values()].every((value) => value === 0);
};

module.exports = { minimizeTransactions, verifyTransfers };
