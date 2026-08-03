const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const settlementRepository = require("../repositories/settlementRepository");
const balanceService = require("./balanceService");
const memberService = require("./memberService");
const activityService = require("./activityService");
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
  });

  const nameMap = await memberService.buildNameMap(group._id);
  const fromName = nameMap.get(String(dto.fromMemberId)) || "Someone";
  const toName = nameMap.get(String(dto.toMemberId)) || "someone";

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.SETTLEMENT_RECORDED,
    actor,
    message: `${fromName} paid ${toName} ${formatMinor(amountMinor, group.currency)}`,
    metadata: {
      settlementId: String(settlement._id),
      amountMinor,
      fromName,
      toName,
      recordedBy: actor.name,
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
