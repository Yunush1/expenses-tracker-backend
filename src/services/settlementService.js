const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const settlementRepository = require("../repositories/settlementRepository");
const balanceService = require("./balanceService");
const memberService = require("./memberService");
const activityService = require("./activityService");
const cycleService = require("./cycleService");
const { isMonthly } = require("../utils/periodDues");
const { minimizeTransactions } = require("../utils/settlementOptimizer");
const { toMinor, toMajor, formatMinor } = require("../utils/money");
const { toSettlementDTO } = require("../serializers");
const { buildPage } = require("../utils/cursor");
const { ACTIVITY_TYPES, SETTLEMENT_METHODS, LIMITS, ERROR_CODES } = require("../constants");
const { BadRequestError, NotFoundError } = require("../errors");

/**
 * The fewest payments that clear every debt in the group.
 * Algorithm and its guarantees: docs/05-ALGORITHMS.md §4.
 */
const getSuggestions = async (group, currentMember) => {
  const { balances, isSettled, totals } = await balanceService.computeBalances(group._id);

  const nameById = new Map(balances.map((balance) => [balance.memberId, balance.name]));

  if (isMonthly(group)) return monthlySuggestions(group, currentMember, { nameById, totals });

  const transfers = minimizeTransactions(
    balances.map(({ memberId, netMinor }) => ({ memberId, netMinor }))
  ).map((transfer) => ({
    fromMemberId: transfer.fromMemberId,
    fromName: nameById.get(transfer.fromMemberId) || "Unknown",
    toMemberId: transfer.toMemberId,
    toName: nameById.get(transfer.toMemberId) || "Unknown",
    amountMinor: transfer.amountMinor,
    amount: toMajor(transfer.amountMinor, group.currency),
  }));

  const myId = currentMember ? String(currentMember._id) : null;

  return {
    transfers,
    transactionCount: transfers.length,
    isSettled: isSettled && transfers.length === 0,
    totals,
    myTransfers: myId
      ? {
          toPay: transfers.filter((transfer) => transfer.fromMemberId === myId),
          toReceive: transfers.filter((transfer) => transfer.toMemberId === myId),
        }
      : null,
  };
};

/**
 * Settle-up for a monthly group: each pair's open dues across every month, per
 * direction — never netted against each other and never routed through a third
 * person (docs/29-BALANCE-CYCLES.md §4). Same response shape as the all-time
 * version, plus the months each transfer covers, so the existing settle-up screen
 * keeps working and paying a suggestion clears exactly what it lists.
 *
 * `isSettled` means *no open dues at all*. The all-time figure would be wrong
 * here: A owing B for September while B owes A the same for October is zero
 * all-time and two real dues.
 */
const monthlySuggestions = async (group, currentMember, { nameById, totals }) => {
  const pairs = await cycleService.suggestionsFor(group);
  const current = cycleService.currentPeriodKey();

  const transfers = pairs.map((pair) => ({
    fromMemberId: pair.fromMemberId,
    fromName: nameById.get(pair.fromMemberId) || "Unknown",
    toMemberId: pair.toMemberId,
    toName: nameById.get(pair.toMemberId) || "Unknown",
    amountMinor: pair.amountMinor,
    amount: toMajor(pair.amountMinor, group.currency),
    periods: pair.periods.map((period) => ({
      periodKey: period.periodKey,
      label: cycleService.monthLabel(period.periodKey),
      isCurrent: period.periodKey === current,
      amountMinor: period.amountMinor,
      amount: toMajor(period.amountMinor, group.currency),
    })),
  }));

  const myId = currentMember ? String(currentMember._id) : null;

  return {
    transfers,
    transactionCount: transfers.length,
    isSettled: transfers.length === 0,
    totals,
    balanceCycle: group.balanceCycle,
    myTransfers: myId
      ? {
          toPay: transfers.filter((transfer) => transfer.fromMemberId === myId),
          toReceive: transfers.filter((transfer) => transfer.toMemberId === myId),
        }
      : null,
  };
};

const recordSettlement = async ({ group, actor, dto }) => {
  if (dto.clientRequestId) {
    const existing = await settlementRepository.findByClientRequestId(group._id, dto.clientRequestId);
    if (existing) {
      const nameMap = await memberService.buildNameMap(group._id);
      return { settlement: toSettlementDTO(existing, nameMap, group.currency), created: false };
    }
  }

  if (String(dto.fromMemberId) === String(dto.toMemberId)) {
    throw new BadRequestError("A member cannot settle with themselves", ERROR_CODES.SELF_SETTLEMENT);
  }

  const amountMinor = toMinor(dto.amount, group.currency);

  const members = await memberRepository.findActiveByIds(group._id, [dto.fromMemberId, dto.toMemberId]);
  const foundIds = new Set(members.map((member) => String(member._id)));

  if (!foundIds.has(String(dto.fromMemberId)) || !foundIds.has(String(dto.toMemberId))) {
    throw new NotFoundError(
      "Both members must be active members of this group",
      ERROR_CODES.MEMBER_NOT_FOUND
    );
  }

  /**
   * Monthly groups only: which months this pays down — the named one, or oldest
   * first (docs/29-BALANCE-CYCLES.md §4). `[]` everywhere else, so a continuous
   * group's settlement is exactly the row it always was.
   */
  const allocations = await cycleService.allocationsFor({
    group,
    fromMemberId: dto.fromMemberId,
    toMemberId: dto.toMemberId,
    amountMinor,
    periodKey: dto.periodKey,
  });

  const settlement = await settlementRepository.create({
    groupId: group._id,
    fromMemberId: dto.fromMemberId,
    toMemberId: dto.toMemberId,
    amountMinor,
    currencyCode: group.currency,
    method: dto.method || SETTLEMENT_METHODS.MANUAL,
    note: dto.note || "",
    settledAt: dto.settledAt || new Date(),
    recordedByMemberId: actor._id,
    clientRequestId: dto.clientRequestId || null,
    allocations,
  });

  const nameMap = await memberService.buildNameMap(group._id);
  const fromName = nameMap.get(String(dto.fromMemberId)) || "Someone";
  const toName = nameMap.get(String(dto.toMemberId)) || "someone";

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.SETTLEMENT_RECORDED,
    actor,
    message: `${fromName} paid ${toName} ${formatMinor(amountMinor, group.currency)}${
      allocations.length > 0
        ? ` for ${allocations.map((entry) => cycleService.monthLabel(entry.periodKey)).join(", ")}`
        : ""
    }`,
    metadata: {
      settlementId: String(settlement._id),
      amountMinor,
      fromName,
      toName,
      recordedBy: actor.name,
      // Monthly groups: which months this cleared. Absent elsewhere.
      ...(allocations.length > 0 ? { allocations } : {}),
    },
  });

  await groupRepository.touchActivity(group._id);

  // No cache to invalidate — the next balance read derives from this record.
  return { settlement: toSettlementDTO(settlement, nameMap, group.currency), created: true };
};

const listSettlements = async (group, { cursor, limit = LIMITS.DEFAULT_PAGE_SIZE } = {}) => {
  const [rows, nameMap] = await Promise.all([
    settlementRepository.listByGroup(group._id, { cursor, limit }),
    memberService.buildNameMap(group._id),
  ]);

  const page = buildPage(rows, limit);

  return {
    items: page.items.map((settlement) => toSettlementDTO(settlement, nameMap, group.currency)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
};

module.exports = { getSuggestions, recordSettlement, listSettlements };
