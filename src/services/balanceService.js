const expenseRepository = require("../repositories/expenseRepository");
const settlementRepository = require("../repositories/settlementRepository");
const memberRepository = require("../repositories/memberRepository");
// Leaf module — Redis only, so no cycle back through the services.
const cacheService = require("./cacheService");
const logger = require("../utils/logger");

/**
 * Balances are DERIVED, never stored.
 *
 * A cached balance that disagrees with the expense list is a bug the user can see —
 * they add the expenses up themselves and get a different number. Deriving on read
 * makes disagreement structurally impossible. The cost is one indexed aggregation
 * per read, which is single-digit milliseconds at the MVP's design point; the
 * materialised-balance scale path is in docs/02-HLD.md §7.
 *
 *   net = paid − share + settlementsPaid − settlementsReceived
 *
 * A settlement moves BOTH parties toward zero: the payer's net rises (they have now
 * put in more), the receiver's falls (they have been made whole by that much).
 * See docs/05-ALGORITHMS.md §3.
 */

const toTotalsMap = (rows = []) =>
  new Map(rows.map((row) => [String(row._id), row.total]));

/** How many expenses each member entered — for the per-person expense view. */
const toCountsMap = (rows = []) =>
  new Map(rows.map((row) => [String(row._id), row.count || 0]));

/**
 * The uncached computation. Everything below the cache calls this.
 *
 * Kept separate and exported so any caller that must not read a cached copy —
 * a migration, a consistency check, an assertion — has a way to bypass it.
 */
const computeBalancesFresh = async (groupId) => {
  const [members, expenseAgg, settlementAgg] = await Promise.all([
    memberRepository.findByGroup(groupId, { includeInactive: true }),
    expenseRepository.aggregateTotals(groupId),
    settlementRepository.aggregateTotals(groupId),
  ]);

  const expenseFacets = expenseAgg[0] || {};
  const settlementFacets = settlementAgg[0] || {};

  const paidMap = toTotalsMap(expenseFacets.paid);
  const paidCountMap = toCountsMap(expenseFacets.paid);
  const shareMap = toTotalsMap(expenseFacets.shared);
  const settlePaidMap = toTotalsMap(settlementFacets.paid);
  const settleReceivedMap = toTotalsMap(settlementFacets.received);

  const overall = expenseFacets.overall?.[0] || { totalSpentMinor: 0, count: 0 };
  const settlementCount = settlementFacets.overall?.[0]?.count || 0;

  const balances = members
    .filter((member) => {
      const key = String(member._id);
      // Removed members are only kept in the list if they still carry history.
      return (
        member.isActive !== false ||
        paidMap.has(key) ||
        shareMap.has(key) ||
        settlePaidMap.has(key) ||
        settleReceivedMap.has(key)
      );
    })
    .map((member) => {
      const key = String(member._id);
      const paidMinor = paidMap.get(key) || 0;
      const shareMinor = shareMap.get(key) || 0;
      const settlementPaidMinor = settlePaidMap.get(key) || 0;
      const settlementReceivedMinor = settleReceivedMap.get(key) || 0;

      return {
        memberId: key,
        name: member.name,
        isActive: member.isActive !== false,
        paidMinor,
        /** Expenses this member entered — drives the per-person view's header. */
        paidCount: paidCountMap.get(key) || 0,
        shareMinor,
        settlementPaidMinor,
        settlementReceivedMinor,
        netMinor: paidMinor - shareMinor + settlementPaidMinor - settlementReceivedMinor,
      };
    });

  assertZeroSum(groupId, balances);

  return {
    balances,
    totals: {
      totalSpentMinor: overall.totalSpentMinor || 0,
      expenseCount: overall.count || 0,
      settlementCount,
      memberCount: members.filter((member) => member.isActive !== false).length,
    },
    isSettled: balances.every((balance) => balance.netMinor === 0),
  };
};

/**
 * Balances, read through the group's version-keyed cache.
 *
 * This is the hottest read in the app — the summary, the settlement optimiser,
 * the per-person view and the AI snapshot all start here, so one group screen
 * recomputes it several times over.
 *
 * Caching it does not contradict "balances are derived, never cached"
 * (docs/05-ALGORITHMS.md §3). That rule forbids a *stored* balance that can
 * drift from the rows beneath it. Here the key carries the group's version, and
 * every write bumps it — so a cache hit is only ever possible while nothing has
 * changed, and the first write makes every stored copy unreachable. What is
 * served is a freshly-derived balance that happened to be derived a moment ago,
 * never one that survived an edit.
 *
 * The zero-sum assertion still runs on the computed result, so a cached copy is
 * one that already passed it.
 */
const computeBalances = (groupId) =>
  cacheService.rememberGroup(groupId, "balances", () => computeBalancesFresh(groupId));

/**
 * Σ net must be exactly zero — every expense and every settlement contributes a
 * zero-sum pair, and the split calculator guarantees each expense distributes
 * exactly. A violation means a data-integrity bug, and it is better to know.
 */
const assertZeroSum = (groupId, balances) => {
  const total = balances.reduce((sum, balance) => sum + balance.netMinor, 0);

  if (total !== 0) {
    logger.error(
      `[balanceService] Zero-sum invariant violated for group ${groupId}: Σ net = ${total}`
    );
  }

  return total === 0;
};

/** Convenience for the dashboard header — one member's slice of the full result. */
const getMemberBalance = (balanceResult, memberId) => {
  if (!memberId) return null;
  return balanceResult.balances.find((balance) => balance.memberId === String(memberId)) || null;
};

module.exports = {
  computeBalances,
  computeBalancesFresh,
  getMemberBalance,
  assertZeroSum,
};
