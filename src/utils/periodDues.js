/**
 * Per-month dues for monthly groups — pure arithmetic, no I/O
 * (docs/29-BALANCE-CYCLES.md).
 *
 * ## What is derived, and why nothing here is stored
 *
 * A month's dues are not a table that a job writes when the month ends. They are
 * a function of two things that already exist:
 *
 *   • the month's expenses — every share is a debt from its participant to the
 *     expense's payer, in the month the expense is dated
 *   • settlements, each tagged (via `allocations`) with the months it pays down
 *
 * Deriving them keeps the rule this codebase has held since the start — balances
 * are derived, never stored (docs/05-ALGORITHMS.md §3) — and it disposes of most
 * of what a stored design has to get right: there is no month-end job to run
 * twice, no PAID flag to drift from the rows beneath it, and a late expense added
 * during the grace window simply changes last month's dues, which is true.
 *
 * ## Pairwise, never optimised
 *
 * The all-time settle-up minimises the number of transfers across the whole
 * group, which can route a debt through somebody who never shared an expense with
 * either party. That is fine for a running balance and wrong for a *due*: a due is
 * something one named person asks another named person for, and a merge is an
 * agreement between those two. So within each month every pair is netted, and
 * pairs are never chained.
 *
 * ## Invariants, asserted in tests/periodDues.test.js
 *
 *   • within any month, Σ over members of (owed to them − owed by them) = 0
 *   • across all months, each member's sum equals their all-time `netMinor`
 *   • OFFSET and CARRY_FORWARD pairs leave every all-time balance unchanged
 */

const { localParts } = require("./expensePeriod");
const { localDateString } = require("./localTime");
const { BALANCE_CYCLES } = require("../constants");

const PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

const isPeriodKey = (value) => typeof value === "string" && PERIOD_KEY.test(value);

/** `2026-09` in the configured zone — the same boundary the edit lock uses. */
const periodKeyOf = (date, timeZone) => localParts(new Date(date), timeZone).monthKey;

/** `2026-09` → `{ start: "2026-09-01", end: "2026-09-30" }`, as calendar days. */
const periodBounds = (periodKey) => {
  const [year, month] = periodKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${periodKey}-01`, end: `${periodKey}-${String(lastDay).padStart(2, "0")}` };
};

/* ------------------------------ Cycle rules ------------------------------ */

/** A group with no stored cycle predates cycles and has always run continuously. */
const cycleOf = (group) => group?.balanceCycle || BALANCE_CYCLES.CONTINUOUS;

const isMonthly = (group) => cycleOf(group) === BALANCE_CYCLES.MONTHLY;

/**
 * Does the month edit lock (utils/expensePeriod.js) apply to this group?
 *
 * Monthly groups: yes — and it is what makes a month's dues settle down once its
 * grace window has passed, without anything having to "close" it.
 *
 * Groups created before cycles: yes — they have always had it, and turning it
 * off on deploy would be a behaviour change nobody asked for.
 *
 * Continuous groups created as such: **no**. A trip from September to December is
 * one ledger, and refusing to correct a September dinner in November because the
 * calendar turned over is exactly what Continuous exists to avoid. Their gate is
 * the end date and closing instead.
 */
const usesMonthLock = (group) => !group?.balanceCycle || isMonthly(group);

/** A stored calendar date (UTC midnight) → `YYYY-MM-DD`. */
const dayString = (date) => (date ? new Date(date).toISOString().slice(0, 10) : null);

const addDays = (dayStr, days) =>
  new Date(Date.parse(`${dayStr}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Is this continuous group closed — by hand, or by being past its end date plus
 * the grace period?
 *
 * Read on every write rather than trusting the sweep that sets `closedAt`, so a
 * group whose end date passed an hour before the sweep runs is already closed.
 * The grace is the same one the month lock gives: people add the last taxi the
 * morning after a trip ends, and refusing that is the one thing a close date must
 * not do.
 */
const isClosed = (group, now, { graceDays, timeZone }) => {
  if (cycleOf(group) !== BALANCE_CYCLES.CONTINUOUS) return false;
  if (group.closedAt) return true;
  if (!group.endDate) return false;
  return localDateString(now, timeZone) > addDays(dayString(group.endDate), graceDays);
};

/* ------------------------------- Dues maths ------------------------------ */

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Every open due, in every month: `[{ periodKey, fromMemberId, toMemberId, amountMinor }]`,
 * each meaning "from owes to this much for that month". Oldest month first.
 *
 * @param {object}   input
 * @param {object[]} input.debts        `{ periodKey, fromMemberId, toMemberId, amountMinor }`
 *                                       — expense shares, already grouped by month
 *                                       (expenseRepository.pairDebtsByMonth)
 * @param {object[]} input.settlements  settlement rows as stored
 * @param {string}   input.timeZone     for settlements with no allocations
 */
const buildDues = ({ debts = [], settlements = [], timeZone }) => {
  /** periodKey → (pairKey → signed amount; positive means the lower id owes the higher). */
  const periods = new Map();

  const add = (periodKey, debtor, creditor, amountMinor) => {
    const from = String(debtor);
    const to = String(creditor);
    if (!amountMinor || from === to) return;

    let pairs = periods.get(periodKey);
    if (!pairs) {
      pairs = new Map();
      periods.set(periodKey, pairs);
    }

    const key = pairKey(from, to);
    const sign = from < to ? 1 : -1;
    pairs.set(key, (pairs.get(key) || 0) + sign * amountMinor);
  };

  for (const debt of debts) add(debt.periodKey, debt.fromMemberId, debt.toMemberId, debt.amountMinor);

  for (const settlement of settlements) {
    const allocations =
      settlement.allocations && settlement.allocations.length > 0
        ? settlement.allocations
        : [
            {
              periodKey: periodKeyOf(settlement.settledAt || settlement.createdAt || new Date(), timeZone),
              amountMinor: settlement.amountMinor,
            },
          ];

    // A payment from → to is the mirror of a debt: it is what `to` now owes back.
    for (const allocation of allocations) {
      add(allocation.periodKey, settlement.toMemberId, settlement.fromMemberId, allocation.amountMinor);
    }
  }

  const dues = [];
  for (const [periodKey, pairs] of periods) {
    for (const [key, signed] of pairs) {
      if (signed === 0) continue;
      const [low, high] = key.split("|");
      dues.push(
        signed > 0
          ? { periodKey, fromMemberId: low, toMemberId: high, amountMinor: signed }
          : { periodKey, fromMemberId: high, toMemberId: low, amountMinor: -signed }
      );
    }
  }

  return dues.sort(
    (a, b) =>
      a.periodKey.localeCompare(b.periodKey) ||
      a.fromMemberId.localeCompare(b.fromMemberId) ||
      a.toMemberId.localeCompare(b.toMemberId)
  );
};

/** Member → net for one month (positive: owed to them). Every month sums to zero. */
const netsForPeriod = (dues, periodKey) => {
  const nets = new Map();
  for (const due of dues) {
    if (due.periodKey !== periodKey) continue;
    nets.set(due.toMemberId, (nets.get(due.toMemberId) || 0) + due.amountMinor);
    nets.set(due.fromMemberId, (nets.get(due.fromMemberId) || 0) - due.amountMinor);
  }
  return nets;
};

/** What `from` owes `to`, oldest month first, optionally only before a month. */
const owedBetween = (dues, fromMemberId, toMemberId, { before } = {}) =>
  dues.filter(
    (due) =>
      due.fromMemberId === String(fromMemberId) &&
      due.toMemberId === String(toMemberId) &&
      (!before || due.periodKey < before)
  );

const sumMinor = (rows) => rows.reduce((sum, row) => sum + row.amountMinor, 0);

/** Take up to `amountMinor` from `rows` in order. Returns the allocations and what is left. */
const takeInOrder = (rows, amountMinor) => {
  const allocations = [];
  let remaining = amountMinor;
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, row.amountMinor);
    allocations.push({ periodKey: row.periodKey, amountMinor: take });
    remaining -= take;
  }
  return { allocations, remaining };
};

const pushInto = (allocations, periodKey, amountMinor) => {
  if (amountMinor <= 0) return allocations;
  const existing = allocations.find((entry) => entry.periodKey === periodKey);
  if (existing) existing.amountMinor += amountMinor;
  else allocations.push({ periodKey, amountMinor });
  return allocations;
};

/**
 * Which months a payment from → to pays down.
 *
 * Named month: all of it goes there — the person said which due they were paying
 * (PRD §14), and an overpayment then means that month is owed back, which is what
 * happened.
 *
 * No month: oldest first across every month `from` owes `to` in, the current one
 * last. Anything beyond what is owed lands in the current month, where it simply
 * makes `to` owe `from` — an overpayment is recorded as one, not refused.
 */
const allocatePayment = ({ dues, fromMemberId, toMemberId, amountMinor, currentPeriodKey, periodKey }) => {
  if (periodKey) return [{ periodKey, amountMinor }];

  const owed = owedBetween(dues, fromMemberId, toMemberId);
  const { allocations, remaining } = takeInOrder(owed, amountMinor);
  return pushInto(allocations, currentPeriodKey, remaining);
};

/**
 * Plan a CARRY_FORWARD: move up to `amountMinor` of what `from` owes `to` from
 * earlier months into the current one.
 *
 * Two rows result (see cycleService): from → to allocated to the source months,
 * which clears them; and to → from allocated to the current month, which makes
 * `from` owe the same amount there. Net cash zero, every all-time balance
 * unchanged.
 *
 * Clamped to what is actually owed — a merge request for ₹1,000 accepted after
 * ₹400 was paid moves ₹600, not ₹1,000.
 */
const planMerge = ({ dues, fromMemberId, toMemberId, amountMinor, currentPeriodKey }) => {
  const previous = owedBetween(dues, fromMemberId, toMemberId, { before: currentPeriodKey });
  const available = sumMinor(previous);
  const amount = Math.min(amountMinor ?? available, available);
  if (amount <= 0) return null;

  const { allocations } = takeInOrder(previous, amount);
  return {
    amountMinor: amount,
    /** from → to: clears the earlier months. */
    clearing: allocations,
    /** to → from: re-creates the debt in the current month. */
    carrying: [{ periodKey: currentPeriodKey, amountMinor: amount }],
  };
};

/**
 * Plan an OFFSET: cancel what `a` owes `b` against what `b` owes `a`.
 *
 * Within one month a pair is already netted, so opposite debts only ever exist in
 * *different* months — "A3 owes A2 ₹1,000 for September, A2 owes A3 ₹100 for
 * October". The offset is min(the two totals), taken oldest first on each side.
 *
 * Two rows result: a → b allocated to a's months, b → a allocated to b's. Each
 * clears that much on its side; together they move no money.
 */
const planOffset = ({ dues, aMemberId, bMemberId, amountMinor }) => {
  const aOwes = owedBetween(dues, aMemberId, bMemberId);
  const bOwes = owedBetween(dues, bMemberId, aMemberId);
  const available = Math.min(sumMinor(aOwes), sumMinor(bOwes));
  const amount = Math.min(amountMinor ?? available, available);
  if (amount <= 0) return null;

  return {
    amountMinor: amount,
    aToB: takeInOrder(aOwes, amount).allocations,
    bToA: takeInOrder(bOwes, amount).allocations,
  };
};

/**
 * One member's dues, grouped by the person on the other side (PRD "settle by
 * person"): `[{ memberId, iOweMinor, owedToMeMinor, iOwe: [...], owedToMe: [...] }]`.
 *
 * Both directions are kept, never netted — netting is the OFFSET action, and
 * doing it silently here would be the automatic reduction PRD §13 forbids.
 */
const byCounterparty = (dues, memberId, { before } = {}) => {
  const me = String(memberId);
  const people = new Map();

  const entry = (other) => {
    if (!people.has(other)) {
      people.set(other, { memberId: other, iOweMinor: 0, owedToMeMinor: 0, iOwe: [], owedToMe: [] });
    }
    return people.get(other);
  };

  for (const due of dues) {
    if (before && due.periodKey >= before) continue;
    if (due.fromMemberId === me) {
      const person = entry(due.toMemberId);
      person.iOweMinor += due.amountMinor;
      person.iOwe.push({ periodKey: due.periodKey, amountMinor: due.amountMinor });
    } else if (due.toMemberId === me) {
      const person = entry(due.fromMemberId);
      person.owedToMeMinor += due.amountMinor;
      person.owedToMe.push({ periodKey: due.periodKey, amountMinor: due.amountMinor });
    }
  }

  return [...people.values()].sort(
    (a, b) => b.iOweMinor + b.owedToMeMinor - (a.iOweMinor + a.owedToMeMinor)
  );
};

module.exports = {
  isPeriodKey,
  periodKeyOf,
  periodBounds,
  cycleOf,
  isMonthly,
  usesMonthLock,
  dayString,
  isClosed,
  buildDues,
  netsForPeriod,
  owedBetween,
  sumMinor,
  allocatePayment,
  planMerge,
  planOffset,
  byCounterparty,
};
