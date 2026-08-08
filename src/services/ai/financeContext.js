const User = require("../../models/user");
const Member = require("../../models/member");
const Group = require("../../models/group");
const Expense = require("../../models/expense");
const Ledger = require("../../models/ledger");
const LedgerEntry = require("../../models/ledgerEntry");

const contextCache = require("./contextCache");
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

/**
 * Enough for "what did I spend recently" without shipping a life history.
 *
 * ## These are accuracy limits, not just cost limits
 *
 * Measured against the configured 8B model: at ~15,000 characters of context it
 * loses rows — asked about a person it reported no such record, then listed that
 * same person among the names it knew in the very next answer. Cut to ~1,000
 * characters it answered correctly. Every row here competes for the model's
 * attention with the row that actually holds the answer.
 *
 * So these caps buy correctness first and tokens second. Raise them only
 * alongside a model that can hold the extra, and re-test the per-person
 * questions afterwards — they fail first.
 */
const RECENT_LEDGER_ENTRIES = 20;
const RECENT_GROUP_EXPENSES = 12;
const RECENT_SETTLEMENTS = 8;
const MAX_GROUPS = 5;

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

  /**
   * Two routes in, and the explicit one wins.
   *
   * `member.userId` is set only when the person confirmed "yes, that member is
   * me" (docs/17-MEMBER-IDENTITY.md §6). It survives a new phone and a cleared
   * browser, which the device route does not — so an account that has linked
   * gets the right groups on a device it has never used before.
   *
   * The device route stays as the fallback for everyone who has not linked, and
   * is still read-only: resolving which groups to *describe* never writes a
   * `userId` onto a membership.
   */
  const members = await Member.find({
    isActive: true,
    $or: [
      { userId: user._id },
      ...(deviceIds.length ? [{ deviceIds: { $in: deviceIds } }] : []),
    ],
  })
    .select("_id groupId name userId")
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

  /**
   * One "me" per group, and the linked member wins.
   *
   * A browser can hold a stale membership in a group the account has since
   * linked to a different member — describing the group as the wrong person
   * would report someone else's balance as theirs. Sorting the confirmed link
   * last means it overwrites the device guess in the map.
   */
  const memberByGroup = new Map(
    [...members]
      .sort((a, b) => Number(Boolean(a.userId)) - Number(Boolean(b.userId)))
      .map((m) => [String(m.groupId), m])
  );

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

/**
 * Per-person totals — the answer to "how much did I pay Krishan?".
 *
 * ## Why this has to exist
 *
 * The system prompt forbids the model from doing arithmetic, and rightly: a
 * model that adds up a column of rupees will eventually get one wrong and say it
 * fluently. But "how much have I paid X" is an aggregate across loans,
 * repayments and group settlements — so with no precomputed figure the model is
 * asked a question it is explicitly barred from working out. It then does the
 * only honest thing left and says it cannot, which reads as the assistant being
 * broken.
 *
 * So the total is computed here, in integer minor units, by the same rule the
 * rest of the app uses. The model is handed the finished figure and asked to
 * talk about it — which is the whole design (docs/10-AI-ASSISTANT.md §2).
 *
 * Names are merged case-insensitively because a ledger counterparty is typed by
 * hand ("mayank") while a group member is a display name ("Mayank"), and to the
 * person asking they are obviously the same human.
 */
const buildPeople = async (userId, ledgerId, currency, groupRefs) => {
  const byKey = new Map();

  const bucket = (name) => {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return null;
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: String(name).trim(),
        youLentThemMinor: 0,
        youBorrowedFromThemMinor: 0,
        theyPaidYouBackMinor: 0,
        youPaidThemBackMinor: 0,
        theyOweYouMinor: 0,
        youOweThemMinor: 0,
        youPaidThemInGroupsMinor: 0,
        theyPaidYouInGroupsMinor: 0,
        groups: [],
      });
    }
    return byKey.get(key);
  };

  /**
   * Every debt, not just the recent page.
   *
   * A total computed over the most recent forty rows is a wrong total, and a
   * wrong total stated confidently is the failure this whole module is built to
   * avoid. Debts are few by nature, so the full set is cheap.
   */
  if (ledgerId) {
    const debts = await LedgerEntry.find({
      ledgerId,
      isDeleted: { $ne: true },
      type: { $in: [LEDGER_ENTRY_TYPES.LENT, LEDGER_ENTRY_TYPES.BORROWED] },
    })
      .select("type amountMinor repayments counterpartyName settledAt")
      .lean();

    for (const debt of debts) {
      const person = bucket(debt.counterpartyName);
      if (!person) continue;

      const repaid = (debt.repayments || []).reduce((sum, r) => sum + r.amountMinor, 0);
      const outstanding = debt.amountMinor - repaid;

      if (debt.type === LEDGER_ENTRY_TYPES.LENT) {
        person.youLentThemMinor += debt.amountMinor;
        person.theyPaidYouBackMinor += repaid;
        person.theyOweYouMinor += outstanding;
      } else {
        person.youBorrowedFromThemMinor += debt.amountMinor;
        person.youPaidThemBackMinor += repaid;
        person.youOweThemMinor += outstanding;
      }
    }
  }

  /**
   * Settlements are money that actually moved between two people, which is
   * exactly what "how much did I pay them" means inside a group — distinct from
   * a share of a bill, which is what they owed rather than what they handed over.
   */
  for (const { group, me } of groupRefs) {
    const [settlements, others] = await Promise.all([
      Settlement.find({
        groupId: group._id,
        $or: [{ fromMemberId: me._id }, { toMemberId: me._id }],
      })
        .select("fromMemberId toMemberId amountMinor")
        .lean(),
      Member.find({ groupId: group._id, isActive: true }).select("_id name").lean(),
    ]);

    /**
     * Seed everyone in the group, settled with or not.
     *
     * Otherwise someone you share a group with but have never transferred money
     * to is simply absent, and the prompt's rule for an absent name — "say you
     * have no record of anyone by that name" — turns a correct ₹0.00 into a
     * flat denial that the person exists. Zero is an answer; missing is not.
     */
    for (const other of others) {
      if (String(other._id) === String(me._id)) continue;
      const person = bucket(other.name);
      if (person && !person.groups.includes(group.name)) person.groups.push(group.name);
    }

    const nameById = new Map(others.map((m) => [String(m._id), m.name]));

    for (const s of settlements) {
      const iPaid = String(s.fromMemberId) === String(me._id);
      const otherId = iPaid ? s.toMemberId : s.fromMemberId;
      const person = bucket(nameById.get(String(otherId)));
      if (!person) continue;

      if (iPaid) person.youPaidThemInGroupsMinor += s.amountMinor;
      else person.theyPaidYouInGroupsMinor += s.amountMinor;

      if (!person.groups.includes(group.name)) person.groups.push(group.name);
    }
  }

  // Formatted last, so every sum above stayed an integer.
  return [...byKey.values()]
    .map((p) => ({
      name: p.name,
      inGroups: p.groups.length ? p.groups : undefined,
      /** What each side has actually handed over, ledger and groups combined. */
      youHavePaidThemInTotal: formatMinor(
        p.youPaidThemBackMinor + p.youPaidThemInGroupsMinor,
        currency
      ),
      theyHavePaidYouInTotal: formatMinor(
        p.theyPaidYouBackMinor + p.theyPaidYouInGroupsMinor,
        currency
      ),
      youLentThem: formatMinor(p.youLentThemMinor, currency),
      youBorrowedFromThem: formatMinor(p.youBorrowedFromThemMinor, currency),
      stillOwedToYou: formatMinor(p.theyOweYouMinor, currency),
      youStillOweThem: formatMinor(p.youOweThemMinor, currency),
      paidThemInGroupSettlements: formatMinor(p.youPaidThemInGroupsMinor, currency),
      theyPaidYouInGroupSettlements: formatMinor(p.theyPaidYouInGroupsMinor, currency),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
        /**
         * Present only on rows mirrored from a group expense — this person's
         * share of a bill that also appears under `groups` below.
         *
         * Named and flagged rather than filtered out because both readings are
         * legitimate: "what did I spend this month" should include it, "what do I
         * owe in Goa" should not. The model is told the relationship (see the
         * system prompt) so it can pick, instead of being handed a number that is
         * silently one or the other.
         */
        fromGroup: e.sourceGroupName || undefined,
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
const buildFresh = async (userId) => {
  const user = await User.findById(userId).lean();
  if (!user) return null;

  const [ledger, groupRefs] = await Promise.all([
    describeLedger(userId),
    groupsForUser(user),
  ]);

  const groups = await Promise.all(groupRefs.map(describeGroup));

  const ledgerDoc = await Ledger.findOne({ userId }).select("_id currency").lean();
  const people = await buildPeople(
    userId,
    ledgerDoc?._id || null,
    ledgerDoc?.currency || groupRefs[0]?.group?.currency || "INR",
    groupRefs
  );

  return {
    today: iso(new Date()),
    person: user.displayName || user.email || "there",
    ledger,
    groups,
    /**
     * Named counterparties with their totals already worked out. Listed
     * separately from `ledger` and `groups` because a question about a *person*
     * spans both, and the answer should not depend on the model noticing that.
     */
    people,
    hasAnything: Boolean(ledger) || groups.length > 0,
  };
};

/**
 * The snapshot, from cache when one is warm.
 *
 * Opening the assistant and asking two questions used to rebuild this three
 * times — starters, then each answer — and every rebuild is a ledger summary
 * plus a balance computation and a settlement optimiser run per group. The cache
 * is dropped the moment the person changes anything of their own; see
 * contextCache.js for the freshness argument and the one gap it names.
 */
const build = async (userId) => {
  const cached = await contextCache.read(userId);
  if (cached) return cached;

  const fresh = await buildFresh(userId);
  // Only cache a real snapshot. Caching `null` would pin "this account does not
  // exist" for two minutes.
  if (fresh) await contextCache.write(userId, fresh);

  return fresh;
};

module.exports = {
  build,
  /** Bypasses the cache. For callers that must not read a snapshot at all. */
  buildFresh,
  RECENT_LEDGER_ENTRIES,
  RECENT_GROUP_EXPENSES,
};
