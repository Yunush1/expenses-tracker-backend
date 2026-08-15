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

/**
 * A major-unit twin that stays null when the minor value is absent.
 *
 * `toMajor(null)` is 0, and on a receipt a zero is a claim — "no service charge
 * was printed" and "the service charge was zero" are different facts, and only one
 * of them should render a line.
 */
const money = (minor, currency) => (minor === null || minor === undefined ? null : toMajor(minor, currency));

const toGroupDTO = (group) => ({
  id: id(group._id),
  name: group.name,
  description: group.description || "",
  inviteCode: group.inviteCode,
  // Null when the creator has turned it off, in which case the link is the only
  // way in. Visible to every member — sharing it is the point.
  joinCode: group.joinCode || null,
  currency: group.currency,
  status: group.status,
  /**
   * Whether new people have to be let in. Visible to every member, not only the
   * creator — "can I just send them the link?" is a question anyone in the group
   * needs answered before they send it.
   */
  isPrivate: Boolean(group.isPrivate),
  memberCount: group.memberCount,
  createdAt: group.createdAt,
  lastActivityAt: group.lastActivityAt,
});

/**
 * What a group's plan lets it do (docs/22-MONETIZATION.md §6).
 *
 * Four keys, and the omissions are the design. There is **no price** anywhere in
 * here: what something costs is a question for the upgrade screen, answered by a
 * pricing endpoint, so that a summary sitting in a client's cache from last week
 * cannot quote a figure that has since changed. There is no payer identity either
 * — this payload is read by every member, and who is paying is between the payer
 * and the billing system.
 *
 * `features` is a flat map of booleans meaning "may this group do this **now**".
 * For a metered feature that folds the allowance in: a free group with scans left
 * reads `true`, and the same group with none reads `false`. One boolean the client
 * can trust beats a flag that says "no" beside a counter that says "three left".
 *
 * `limits` carries the numbers behind those booleans, because the wall shown at
 * the limit has to say what was used and when it comes back (§8) — a refusal with
 * no explanation converts nobody.
 */
const toEntitlementDTO = (snapshot) => ({
  plan: snapshot.plan,
  status: snapshot.status,
  expiresAt: snapshot.expiresAt,
  features: snapshot.features,
  limits: snapshot.limits,
});

/** Counts both the array and the pre-migration scalar. See models/member.js. */
const deviceCountOf = (member) => {
  const ids = new Set(member.deviceIds || []);
  if (member.deviceId) ids.add(member.deviceId);
  return ids.size;
};

const toMemberDTO = (member, currentMemberId = null) => {
  const deviceCount = deviceCountOf(member);

  return {
    id: id(member._id),
    name: member.name,
    isCreator: Boolean(member.isCreator),
    isActive: member.isActive !== false,
    hasDevice: deviceCount > 0,
    // Lets the UI show "on 3 devices" and offer to link another. Never the ids
    // themselves — those are the credential.
    deviceCount,
    isYou: currentMemberId != null && id(member._id) === id(currentMemberId),
    /**
     * Whether this member is bound to an account — never *which* account.
     *
     * A boolean is what the UI needs ("linked ✓", or offer to link). The user id
     * would be a stable cross-group identifier handed to everyone holding the
     * invite link, which is a capability URL — so it stays on the server
     * (docs/17-MEMBER-IDENTITY.md §10).
     */
    hasAccount: Boolean(member.userId),
    /**
     * This member's public address, shown to the whole group.
     *
     * Visible to everyone in the group on purpose: the point of a code is that
     * the people who know you can name you on a loan without relying on a
     * display name, and inside a group they already know exactly who is who.
     *
     * The exposure that comes with it, stated plainly: the invite link is a
     * capability URL (docs/02-HLD.md §3.4), so anyone holding it can now read
     * every member's code as well as their name. What that buys an attacker is
     * the ability to *address* a claim at those people — which they still have
     * to accept, and which is capped per sender by ledgerService. It buys no
     * read access and no identity: a member code is never proof of who anyone is
     * (docs/18-USER-CODE.md).
     */
    memberCode: member.memberCode || null,
    joinedAt: member.joinedAt,
  };
};

const toPublicMemberDTO = (member) => ({
  id: id(member._id),
  name: member.name,
  hasDevice: deviceCountOf(member) > 0,
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
    /**
     * The receipt this was read off, when it came from a scan.
     *
     * A list of URLs on this server and nothing else — the write path only accepts
     * paths it produced itself, so this can be rendered directly without a client
     * having to wonder whether the string is a link to somewhere hostile.
     */
    attachments: expense.attachments || [],
    /**
     * What the receipt said, when this came off one. Null on everything typed by
     * hand, which is most expenses — so a client renders a receipt panel only when
     * there is a receipt, rather than an empty one everywhere.
     *
     * Emitted with major-unit twins like every other money field here, because the
     * screen showing "CGST 9% ₹112.50" should not be doing division.
     */
    receipt: expense.receipt
      ? {
          merchant: expense.receipt.merchant || null,
          invoiceNo: expense.receipt.invoiceNo || null,
          gstin: expense.receipt.gstin || null,
          paymentMethod: expense.receipt.paymentMethod || null,
          subtotalMinor: expense.receipt.subtotalMinor ?? null,
          subtotal: money(expense.receipt.subtotalMinor, currency),
          taxes: (expense.receipt.taxes || []).map((tax) => ({
            label: tax.label,
            rate: tax.rate ?? null,
            amountMinor: tax.amountMinor,
            amount: toMajor(tax.amountMinor, currency),
          })),
          taxMinor: (expense.receipt.taxes || []).reduce((sum, tax) => sum + tax.amountMinor, 0),
          serviceMinor: expense.receipt.serviceMinor ?? null,
          service: money(expense.receipt.serviceMinor, currency),
          discountMinor: expense.receipt.discountMinor ?? null,
          discount: money(expense.receipt.discountMinor, currency),
          tipMinor: expense.receipt.tipMinor ?? null,
          tip: money(expense.receipt.tipMinor, currency),
          totalMinor: expense.receipt.totalMinor ?? null,
          total: money(expense.receipt.totalMinor, currency),
          /**
           * Relative to the API, which serves it. A client on another origin has
           * to resolve it — the frontend's `assetUrl` does — because this server
           * has no reliable way to know the hostname it was reached on, and
           * guessing one breaks every deployment that is not the author's.
           */
          imageUrl: expense.receipt.imageUrl || expense.attachments?.[0] || null,
          scannedAt: expense.receipt.scannedAt || null,
        }
      : null,
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
  /** How many expenses this member entered — for the per-person expense view. */
  paidCount: balance.paidCount || 0,
  shareMinor: balance.shareMinor,
  share: toMajor(balance.shareMinor, currency),
  netMinor: balance.netMinor,
  net: toMajor(balance.netMinor, currency),
  status: balanceStatus(balance.netMinor),
  isYou: currentMemberId != null && id(balance.memberId) === id(currentMemberId),
});

module.exports = {
  toGroupDTO,
  toEntitlementDTO,
  toMemberDTO,
  toPublicMemberDTO,
  toExpenseDTO,
  toSettlementDTO,
  toActivityDTO,
  toBalanceDTO,
  balanceStatus,
};
