const User = require("../../models/user");
const Member = require("../../models/member");
const Group = require("../../models/group");
const Expense = require("../../models/expense");
const Ledger = require("../../models/ledger");
const LedgerEntry = require("../../models/ledgerEntry");

const balanceService = require("../balanceService");
const ledgerService = require("../ledgerService");
const settlementService = require("../settlementService");
const Settlement = require("../../models/settlement");
const { formatMinor } = require("../../utils/money");
const { GROUP_STATUS, LEDGER_ENTRY_TYPES } = require("../../constants");

/**
 * Everything the assistant is allowed to know, assembled by code.
 *
 * ## Why the numbers are computed here and not by the model
 *
 * This is the mechanism behind docs/10-AI-ASSISTANT.md §2. Every total, balance
 * and outstanding amount in the context below is produced by the same services
 * that render the UI — `balanceService`, `ledgerService` — which carry the
 * assertions this app's credibility rests on (`Σ shares = amount`,
 * `Σ net = 0`, integer minor units).
 *
 * The model is handed **finished figures** and asked to talk about them. It is a
 * presentation layer over arithmetic that already happened, not a calculator.
 * A model that adds up a column of rupees will eventually get one wrong, and a
 * wrong number delivered fluently is worse than no answer at all.
 *
 * ## Why it is bounded
 *
 * Recent rows only, capped. Not for cost — though it helps — but because the
 * context is the privacy boundary: whatever is in here has left the building.
 * Sending someone's entire financial history to answer "what did I spend on
 * food?" is more exposure than the question needs.
 */

/** Enough for "what did I spend recently" without shipping a life history. */
const RECENT_LEDGER_ENTRIES = 40;
const RECENT_GROUP_EXPENSES = 30;
const RECENT_SETTLEMENTS = 15;
const MAX_GROUPS = 8;

const startOfMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

const iso = (date) => (date ? new Date(date).toISOString().slice(0, 10) : null);

/**
 * The groups this account can see.
 *
 * Reached through `User.deviceIds[]` → `Member.deviceIds[]`, the association
 * recorded at sign-in (authService.linkDevice). **Read-only, and deliberately
 * so:** this resolves which groups to *describe*, and never writes a `userId`
 * onto a membership. A device proves a browser was used, not who used it — the
 * argument in authService for why signing in must not claim group identities
 * applies here unchanged.
 */
const groupsForUser = async (user) => {
  const deviceIds = (user.deviceIds || []).filter(Boolean);
  if (deviceIds.length === 0) return [];

  const members = await Member.find({ deviceIds: { $in: deviceIds }, isActive: true })
    .select("_id groupId name")
    .lean();
  if (members.length === 0) return [];

  const groups = await Group.find({
    _id: { $in: [...new Set(members.map((m) => String(m.groupId)))] },
    status: { $ne: GROUP_STATUS.DELETED },
  })
    .select("_id name currency status lastActivityAt")
    .sort({ lastActivityAt: -1 })
    .limit(MAX_GROUPS)
    .lean();

  const memberByGroup = new Map(members.map((m) => [String(m.groupId), m]));
  return groups.map((group) => ({ group, me: memberByGroup.get(String(group._id)) }));
};

/**
 * One group, described from this person's point of view.
 *
 * Everything here — balances, totals, and the settlement plan — comes from the
 * same services the UI calls, so the assistant and the screen can never disagree.
 * In particular `settlementService.getSuggestions` runs the real
 * transaction-minimising optimiser: the model is told *the* plan, and is never
 * in a position to invent a worse one.
 */
const describeGroup = async ({ group, me }) => {
  const currency = group.currency;

  const [{ balances, totals }, expenses, settlements, suggestions] = await Promise.all([
    balanceService.computeBalances(group._id),
    Expense.find({ groupId: group._id, isDeleted: false })
      .select("description amountMinor paidBy shares expenseDate category")
      .sort({ expenseDate: -1, _id: -1 })
      .limit(RECENT_GROUP_EXPENSES)
      .lean(),
    Settlement.find({ groupId: group._id })
      .select("fromMemberId toMemberId amountMinor settledAt note")
      .sort({ settledAt: -1, _id: -1 })
      .limit(RECENT_SETTLEMENTS)
      .lean(),
    settlementService.getSuggestions(group, me).catch(() => null),
  ]);

  const mine = balances.find((b) => String(b.memberId) === String(me._id));
  const nameById = new Map(balances.map((b) => [String(b.memberId), b.name]));
  const nameOf = (id) => nameById.get(String(id)) || "someone";

  return {
    name: group.name,
    currency,
    status: group.status,
    yourName: me.name,
    // Sign carries the meaning; the label removes any doubt about direction.
    yourNet:
      mine?.netMinor > 0
        ? `you are owed ${formatMinor(mine.netMinor, currency)}`
        : mine?.netMinor < 0
          ? `you owe ${formatMinor(-mine.netMinor, currency)}`
          : "you are settled up",
    totals: {
      totalSpent: formatMinor(totals.totalSpentMinor, currency),
      expenseCount: totals.expenseCount,
      memberCount: totals.memberCount,
      settlementCount: totals.settlementCount,
    },
    members: balances.map((b) => ({
      name: b.name,
      isYou: String(b.memberId) === String(me._id),
      paid: formatMinor(b.paidMinor, currency),
      share: formatMinor(b.shareMinor, currency),
      net:
        b.netMinor > 0
          ? `owed ${formatMinor(b.netMinor, currency)}`
          : b.netMinor < 0
            ? `owes ${formatMinor(-b.netMinor, currency)}`
            : "settled",
    })),
    /**
     * The fewest payments that clear every debt — the app's own answer, not
     * something for the model to work out. "How do we settle up?" is one of the
     * most likely questions, and the optimiser already solves it exactly.
     */
    settlementPlan: suggestions
      ? {
          isSettled: suggestions.isSettled,
          paymentsNeeded: suggestions.transactionCount,
          transfers: suggestions.transfers.map((t) => ({
            from: t.fromName,
            to: t.toName,
            amount: formatMinor(t.amountMinor, currency),
          })),
          yoursToPay: (suggestions.myTransfers?.toPay || []).map(
            (t) => `pay ${t.toName} ${formatMinor(t.amountMinor, currency)}`
          ),
          yoursToReceive: (suggestions.myTransfers?.toReceive || []).map(
            (t) => `receive ${formatMinor(t.amountMinor, currency)} from ${t.fromName}`
          ),
        }
      : null,
    recentExpenses: expenses.map((e) => ({
      date: iso(e.expenseDate),
      description: e.description,
      amount: formatMinor(e.amountMinor, currency),
      category: e.category || undefined,
      paidBy: nameOf(e.paidBy),
      paidByYou: String(e.paidBy) === String(me._id),
      yourShare: formatMinor(
        (e.shares || []).find((s) => String(s.memberId) === String(me._id))?.amountMinor || 0,
        currency
      ),
      splitBetween: (e.shares || []).length,
    })),
    /**
     * Payments already made. Without these the assistant would describe debts
     * that have in fact been settled — the balances account for them, but a
     * question like "did Arjun pay me back?" is unanswerable from balances alone.
     */
    paymentsRecorded: settlements.map((s) => ({
      date: iso(s.settledAt),
      from: nameOf(s.fromMemberId),
      to: nameOf(s.toMemberId),
      amount: formatMinor(s.amountMinor, currency),
      note: s.note || undefined,
    })),
  };
};

/** The personal ledger, if this account has one with anything in it. */
const describeLedger = async (userId) => {
  const ledger = await Ledger.findOne({ userId }).lean();
  if (!ledger) return null;

  const [entries, summary] = await Promise.all([
    LedgerEntry.find({ ledgerId: ledger._id, isDeleted: false })
      .sort({ occurredAt: -1, _id: -1 })
      .limit(RECENT_LEDGER_ENTRIES)
      .lean(),
    ledgerService.getSummary(userId),
  ]);

  if (entries.length === 0) return null;

  const currency = ledger.currency;
  const since = startOfMonth();

  return {
    currency,
    totals: {
      owedToYou: formatMinor(summary.totals.owedToMeMinor, currency),
      youOwe: formatMinor(summary.totals.iOweMinor, currency),
      spentThisMonth: formatMinor(summary.totals.spentMinor, currency),
    },
    spendByCategoryThisMonth: summary.spendByCategory.map((row) => ({
      category: row.category,
      total: formatMinor(row.totalMinor, currency),
      count: row.count,
    })),
    outstandingLoans: entries
      .filter((e) => e.type !== LEDGER_ENTRY_TYPES.SPEND && !e.settledAt)
      .map((e) => ({
        direction: e.type === LEDGER_ENTRY_TYPES.LENT ? "they owe you" : "you owe them",
        person: e.counterpartyName || "unnamed",
        description: e.description,
        outstanding: formatMinor(ledgerService.outstandingOf(e), currency),
        originally: formatMinor(e.amountMinor, currency),
        dueOn: iso(e.dueAt),
        note: e.notes || undefined,
      })),
    recentSpending: entries
      .filter((e) => e.type === LEDGER_ENTRY_TYPES.SPEND)
      .map((e) => ({
        date: iso(e.occurredAt),
        description: e.description,
        amount: formatMinor(e.amountMinor, currency),
        category: e.category || undefined,
        thisMonth: new Date(e.occurredAt) >= since,
        note: e.notes || undefined,
      })),
  };
};

/**
 * Build the whole snapshot for one signed-in account.
 *
 * Returns `null` sections rather than omitting them, so the prompt can say
 * "you have no ledger" instead of the model inferring absence from silence —
 * which it does badly, usually by inventing something.
 */
const build = async (userId) => {
  const user = await User.findById(userId).lean();
  if (!user) return null;

  const [ledger, groupRefs] = await Promise.all([
    describeLedger(userId),
    groupsForUser(user),
  ]);

  const groups = await Promise.all(groupRefs.map(describeGroup));

  return {
    today: iso(new Date()),
    person: user.displayName || user.email || "there",
    ledger,
    groups,
    hasAnything: Boolean(ledger) || groups.length > 0,
  };
};

module.exports = { build, RECENT_LEDGER_ENTRIES, RECENT_GROUP_EXPENSES };
