const { toMajor } = require("../utils/money");
const { BALANCE_STATUS, SPLIT_TYPES } = require("../constants");

/**
 * Shapes domain documents into the API contract (docs/04-API-SPEC.md).
 *
 * Every monetary field is emitted twice: `*Minor` is the authoritative integer,
 * and the major-unit twin is a display convenience. Clients compute from the
 * minor value and render the other.
 */

const id = (value) => (value ? String(value) : null);

const toGroupDTO = (group) => ({
  id: id(group._id),
  name: group.name,
  description: group.description || "",
  inviteCode: group.inviteCode,
  currency: group.currency,
  status: group.status,
  memberCount: group.memberCount,
  createdAt: group.createdAt,
  lastActivityAt: group.lastActivityAt,
});

const toMemberDTO = (member, currentMemberId = null) => ({
  id: id(member._id),
  name: member.name,
  isCreator: Boolean(member.isCreator),
  isActive: member.isActive !== false,
  hasDevice: Boolean(member.deviceId),
  isYou: currentMemberId != null && id(member._id) === id(currentMemberId),
  joinedAt: member.joinedAt,
});

const toPublicMemberDTO = (member) => ({
  id: id(member._id),
  name: member.name,
  hasDevice: Boolean(member.deviceId),
});

/**
 * Split inputs are stored as integers in a per-type unit (constants.SPLIT_VALUE_UNITS);
 * they go out in the unit the user typed, which is the same unit the client sends back.
 */
const splitValueOut = (splitType, value, currency) => {
  if (splitType === SPLIT_TYPES.EXACT) return toMajor(value, currency);
  if (splitType === SPLIT_TYPES.PERCENTAGE) return value / 100;
  return value;
};

const toExpenseDTO = (expense, memberNameById = new Map(), currency = "INR") => {
  const nameOf = (memberId) => memberNameById.get(id(memberId)) || "Unknown";

  return {
    id: id(expense._id),
    description: expense.description,
    amountMinor: expense.amountMinor,
    amount: toMajor(expense.amountMinor, currency),
    currencyCode: expense.currencyCode,
    splitType: expense.splitType,
    paidBy: { id: id(expense.paidBy), name: nameOf(expense.paidBy) },
    shares: expense.shares.map((share) => ({
      memberId: id(share.memberId),
      name: nameOf(share.memberId),
      amountMinor: share.amountMinor,
      amount: toMajor(share.amountMinor, currency),
    })),
    splitValues: (expense.splitValues || []).map((entry) => ({
      memberId: id(entry.memberId),
      value: splitValueOut(expense.splitType, entry.value, currency),
    })),
    participantCount: expense.shares.length,
    expenseDate: expense.expenseDate,
    notes: expense.notes || "",
    category: expense.category,
    createdBy: {
      id: id(expense.createdByMemberId),
      name: nameOf(expense.createdByMemberId),
    },
    version: expense.version,
    createdAt: expense.createdAt,
  };
};

const toSettlementDTO = (settlement, memberNameById = new Map(), currency = "INR") => {
  const nameOf = (memberId) => memberNameById.get(id(memberId)) || "Unknown";

  return {
    id: id(settlement._id),
    from: { id: id(settlement.fromMemberId), name: nameOf(settlement.fromMemberId) },
    to: { id: id(settlement.toMemberId), name: nameOf(settlement.toMemberId) },
    amountMinor: settlement.amountMinor,
    amount: toMajor(settlement.amountMinor, currency),
    currencyCode: settlement.currencyCode,
    method: settlement.method,
    note: settlement.note || "",
    settledAt: settlement.settledAt,
    recordedBy: {
      id: id(settlement.recordedByMemberId),
      name: nameOf(settlement.recordedByMemberId),
    },
    createdAt: settlement.createdAt,
  };
};

const toActivityDTO = (activity) => ({
  id: id(activity._id),
  type: activity.type,
  actorMemberId: id(activity.actorMemberId),
  actorName: activity.actorName,
  message: activity.message,
  metadata: activity.metadata || {},
  createdAt: activity.createdAt,
});

const balanceStatus = (netMinor) => {
  if (netMinor > 0) return BALANCE_STATUS.RECEIVE;
  if (netMinor < 0) return BALANCE_STATUS.OWE;
  return BALANCE_STATUS.SETTLED;
};

const toBalanceDTO = (balance, currentMemberId = null, currency = "INR") => ({
  memberId: id(balance.memberId),
  name: balance.name,
  paidMinor: balance.paidMinor,
  paid: toMajor(balance.paidMinor, currency),
  shareMinor: balance.shareMinor,
  share: toMajor(balance.shareMinor, currency),
  netMinor: balance.netMinor,
  net: toMajor(balance.netMinor, currency),
  status: balanceStatus(balance.netMinor),
  isYou: currentMemberId != null && id(balance.memberId) === id(currentMemberId),
});

module.exports = {
  toGroupDTO,
  toMemberDTO,
  toPublicMemberDTO,
  toExpenseDTO,
  toSettlementDTO,
  toActivityDTO,
  toBalanceDTO,
  balanceStatus,
};
