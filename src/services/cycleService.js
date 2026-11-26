const crypto = require("node:crypto");
const mongoose = require("mongoose");
const config = require("../config/env");
const { withTransaction } = require("../config/db");
const groupRepository = require("../repositories/groupRepository");
const memberRepository = require("../repositories/memberRepository");
const expenseRepository = require("../repositories/expenseRepository");
const settlementRepository = require("../repositories/settlementRepository");
const dueRequestRepository = require("../repositories/dueRequestRepository");
const memberService = require("./memberService");
const activityService = require("./activityService");
const pushService = require("./pushService");
// Leaf module — Redis only, no cycle back through the services.
const cacheService = require("./cacheService");
const dues$ = require("../utils/periodDues");
const { earliestWritableDate } = require("../utils/expensePeriod");
const { localDateString } = require("../utils/localTime");
const { toMinor, toMajor, formatMinor } = require("../utils/money");
const { toGroupDTO } = require("../serializers");
const logger = require("../utils/logger");
const {
  ACTIVITY_TYPES,
  BALANCE_CYCLES,
  DUE_REQUEST_KINDS,
  DUE_REQUEST_STATUS,
  SETTLEMENT_METHODS,
  ERROR_CODES,
} = require("../constants");
const { BadRequestError, ConflictError, ForbiddenError, NotFoundError } = require("../errors");

/**
 * Monthly and continuous balance cycles (docs/29-BALANCE-CYCLES.md).
 *
 * Everything money-shaped here is *derived* — see utils/periodDues.js for the
 * arithmetic and why nothing is stored. What this service adds is the I/O
 * around it: reading the rows, writing the mirrored settlement pairs that offsets
 * and merges are made of, and the requests people send each other.
 */

const periodOptions = () => config.expensePeriod;
const currentPeriodKey = (now = new Date()) => dues$.periodKeyOf(now, periodOptions().timeZone);

/**
 * The month whose dues can no longer change: every month before the earliest one
 * still open to expense edits. During the first `graceDays` of October,
 * September is still settling — a forgotten dinner can still land in it.
 */
const firstOpenPeriodKey = (now = new Date()) => earliestWritableDate(now, periodOptions()).slice(0, 7);

const money = (amountMinor, currency) => ({ amountMinor, amount: toMajor(amountMinor, currency) });

const monthLabel = (periodKey) => {
  const [year, month] = periodKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

const assertMonthly = (group) => {
  if (!dues$.isMonthly(group)) {
    throw new BadRequestError(
      "Previous dues exist only in monthly groups. This group keeps one running balance.",
      ERROR_CODES.NOT_MONTHLY
    );
  }
};

const assertContinuous = (group) => {
  if (dues$.cycleOf(group) !== BALANCE_CYCLES.CONTINUOUS) {
    throw new BadRequestError(
      "Only a continuous group can be closed. A monthly group renews every month.",
      ERROR_CODES.NOT_CONTINUOUS
    );
  }
};

/* --------------------------------- Dues ---------------------------------- */

const computeDuesFresh = async (groupId) => {
  const { timeZone } = periodOptions();
  const [debts, settlements] = await Promise.all([
    expenseRepository.pairDebtsByMonth(groupId, timeZone),
    settlementRepository.listAllByGroup(groupId),
  ]);
  return dues$.buildDues({ debts, settlements, timeZone });
};

/**
 * Read through the group's version-keyed cache, like balances. Every write that
 * can move a due records an activity, and recording one bumps the version
 * (activityService.record), so a cached copy never survives a change.
 *
 * Writes that *plan* from dues — a payment's allocation, an offset, a merge —
 * call `computeDuesFresh` instead: planning from a copy that is a few hundred
 * milliseconds stale is how a payment gets allocated to a month somebody else
 * just paid off.
 */
const computeDues = (groupId) => cacheService.rememberGroup(groupId, "dues", () => computeDuesFresh(groupId));

const loadCounterparty = async (group, actor, memberId) => {
  if (String(memberId) === String(actor._id)) {
    throw new BadRequestError("Choose someone other than yourself", ERROR_CODES.SELF_SETTLEMENT);
  }
  const [member] = await memberRepository.findActiveByIds(group._id, [memberId]);
  if (!member) {
    throw new NotFoundError("That person is not an active member of this group", ERROR_CODES.MEMBER_NOT_FOUND);
  }
  return member;
};

/**
 * Which months a real payment pays down — `[]` outside monthly groups, where
 * settlements stay untagged exactly as they always were.
 *
 * Called by settlementService.recordSettlement, so every payment path — the
 * settle-up button, the PRD's "pay this due", a UPI deep link coming back — is
 * allocated by the same rule.
 */
const allocationsFor = async ({ group, fromMemberId, toMemberId, amountMinor, periodKey }) => {
  if (!dues$.isMonthly(group)) return [];

  const current = currentPeriodKey();
  if (periodKey && periodKey > current) {
    throw new BadRequestError("That month has not started yet", ERROR_CODES.VALIDATION_ERROR);
  }

  const dues = await computeDuesFresh(group._id);
  return dues$.allocatePayment({
    dues,
    fromMemberId: String(fromMemberId),
    toMemberId: String(toMemberId),
    amountMinor,
    currentPeriodKey: current,
    periodKey,
  });
};

/**
 * Settle-up suggestions for a monthly group: every pair's open dues, summed
 * across months, per direction.
 *
 * Not the all-time optimiser. That one may tell A1 to pay A3 for a debt that is,
 * month by month, A1's to A4 — and the payment would then be allocated to a pair
 * that owes nothing. Here a suggestion is always a real pair, and paying it
 * clears exactly the months listed beside it.
 */
const suggestionsFor = async (group) => {
  const dues = await computeDues(group._id);
  const pairs = new Map();

  for (const due of dues) {
    const key = `${due.fromMemberId}>${due.toMemberId}`;
    if (!pairs.has(key)) {
      pairs.set(key, { fromMemberId: due.fromMemberId, toMemberId: due.toMemberId, amountMinor: 0, periods: [] });
    }
    const pair = pairs.get(key);
    pair.amountMinor += due.amountMinor;
    pair.periods.push({ periodKey: due.periodKey, amountMinor: due.amountMinor });
  }

  return [...pairs.values()].sort((a, b) => b.amountMinor - a.amountMinor);
};

/* --------------------------------- Reads --------------------------------- */

const describeCycle = (group, now = new Date()) => {
  const type = dues$.cycleOf(group);
  const closed = dues$.isClosed(group, now, periodOptions());

  if (type === BALANCE_CYCLES.MONTHLY) {
    const periodKey = currentPeriodKey(now);
    const bounds = dues$.periodBounds(periodKey);
    return {
      type,
      isLegacy: false,
      currentPeriod: {
        periodKey,
        label: monthLabel(periodKey),
        startDate: bounds.start,
        endDate: bounds.end,
        status: "ACTIVE",
      },
      /** The earliest expense date still editable — the edit lock's floor. */
      writableFrom: earliestWritableDate(now, periodOptions()),
    };
  }

  return {
    type,
    /** Created before cycles: continuous, and still under the month edit lock. */
    isLegacy: !group.balanceCycle,
    currentPeriod: {
      periodKey: null,
      label: group.name,
      startDate: dues$.dayString(group.startDate) || localDateString(new Date(group.createdAt), periodOptions().timeZone),
      endDate: dues$.dayString(group.endDate),
      status: closed ? "CLOSED" : "ACTIVE",
    },
    closedAt: group.closedAt || null,
    isClosed: closed,
  };
};

/** `GET /groups/:code/cycle` — the PRD's "current period". */
const getCycle = (group) => describeCycle(group);

const personDTO = (person, nameMap, currency, extras = {}) => ({
  member: { id: person.memberId, name: nameMap.get(person.memberId) || "Unknown" },
  iOwe: money(person.iOweMinor, currency),
  owedToMe: money(person.owedToMeMinor, currency),
  iOweByMonth: person.iOwe.map((row) => ({ periodKey: row.periodKey, label: monthLabel(row.periodKey), ...money(row.amountMinor, currency) })),
  owedToMeByMonth: person.owedToMe.map((row) => ({ periodKey: row.periodKey, label: monthLabel(row.periodKey), ...money(row.amountMinor, currency) })),
  ...extras,
});

/**
 * Close requests the arithmetic has overtaken, lazily, on read.
 *
 * A MERGE aimed at a month that is no longer current has expired; a PAYMENT for
 * dues that are now zero has been resolved. Doing this on read rather than in a
 * job means there is no window in which the screen offers "Accept" on a request
 * that can no longer be accepted.
 */
const refreshRequests = async (group, dues, current) => {
  const pending = await dueRequestRepository.listPending(group._id);
  const expired = [];
  const resolved = [];
  const live = [];

  for (const request of pending) {
    const from = String(request.fromMemberId);
    const to = String(request.toMemberId);
    const outstanding = dues$.sumMinor(dues$.owedBetween(dues, from, to, { before: current }));

    if (request.kind === DUE_REQUEST_KINDS.MERGE && request.targetPeriodKey !== current) {
      expired.push(request._id);
    } else if (outstanding === 0) {
      resolved.push(request._id);
    } else {
      live.push({ ...request, outstandingMinor: outstanding });
    }
  }

  await Promise.all([
    dueRequestRepository.closeMany(group._id, expired, DUE_REQUEST_STATUS.EXPIRED),
    dueRequestRepository.closeMany(group._id, resolved, DUE_REQUEST_STATUS.RESOLVED),
  ]);

  return live;
};

const requestDTO = (request, nameMap, currency, viewerId) => {
  const nameOf = (memberId) => ({ id: String(memberId), name: nameMap.get(String(memberId)) || "Unknown" });
  const viewer = viewerId ? String(viewerId) : null;
  const pending = request.status === DUE_REQUEST_STATUS.PENDING;
  const isRespondent = viewer === String(request.respondentMemberId);

  return {
    id: String(request._id),
    kind: request.kind,
    status: request.status,
    /** The debtor and the creditor, whoever sent it. */
    from: nameOf(request.fromMemberId),
    to: nameOf(request.toMemberId),
    requestedBy: nameOf(request.requestedByMemberId),
    respondent: nameOf(request.respondentMemberId),
    /** What was asked for at the time… */
    requested: money(request.amountMinor, currency),
    breakdown: (request.breakdown || []).map((row) => ({
      periodKey: row.periodKey,
      label: monthLabel(row.periodKey),
      ...money(row.amountMinor, currency),
    })),
    /** …and what is owed now. Shown side by side when they differ. */
    outstanding: request.outstandingMinor !== undefined ? money(request.outstandingMinor, currency) : null,
    targetPeriodKey: request.targetPeriodKey || null,
    note: request.note || "",
    createdAt: request.createdAt,
    respondedAt: request.respondedAt || null,
    canAccept: pending && isRespondent && request.kind === DUE_REQUEST_KINDS.MERGE,
    canDecline: pending && isRespondent,
    canCancel: pending && viewer === String(request.requestedByMemberId),
  };
};

/**
 * `GET /groups/:code/dues` — previous-month dues, the current month's position,
 * and the requests in flight.
 *
 * `periods` is the whole group's picture, month by month, newest first — the
 * PRD's history view. `mine` is the same data turned around to face the viewer
 * and grouped by person, which is what "settle by person" and "request that
 * person" are built on.
 */
const getDues = async (group, member, now = new Date()) => {
  assertMonthly(group);

  const current = currentPeriodKey(now);
  const openFrom = firstOpenPeriodKey(now);
  const [dues, nameMap] = await Promise.all([computeDues(group._id), memberService.buildNameMap(group._id)]);
  const requests = await refreshRequests(group, dues, current);
  const { currency } = group;

  const byPeriod = new Map();
  for (const due of dues) {
    if (!byPeriod.has(due.periodKey)) byPeriod.set(due.periodKey, []);
    byPeriod.get(due.periodKey).push(due);
  }

  const periods = [...byPeriod.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([periodKey, rows]) => ({
      periodKey,
      label: monthLabel(periodKey),
      isCurrent: periodKey === current,
      /** False while the month is still inside its grace window and may change. */
      isFinal: periodKey < openFrom,
      total: money(dues$.sumMinor(rows), currency),
      dues: rows.map((row) => ({
        from: { id: row.fromMemberId, name: nameMap.get(row.fromMemberId) || "Unknown" },
        to: { id: row.toMemberId, name: nameMap.get(row.toMemberId) || "Unknown" },
        ...money(row.amountMinor, currency),
      })),
    }));

  const previousDues = dues.filter((due) => due.periodKey < current);

  let mine = null;
  if (member) {
    const me = String(member._id);
    const currentNet = dues$.netsForPeriod(dues, current).get(me) || 0;

    const people = dues$.byCounterparty(dues, me, { before: current }).map((person) => {
      const offset = dues$.planOffset({ dues, aMemberId: me, bMemberId: person.memberId });
      const between = requests.filter(
        (request) =>
          (String(request.fromMemberId) === me && String(request.toMemberId) === person.memberId) ||
          (String(request.toMemberId) === me && String(request.fromMemberId) === person.memberId)
      );
      return personDTO(person, nameMap, currency, {
        /** The most an OFFSET with this person could cancel, across every month. */
        offsetAvailable: money(offset ? offset.amountMinor : 0, currency),
        requests: between.map((request) => requestDTO(request, nameMap, currency, me)),
      });
    });

    mine = {
      memberId: me,
      current: {
        periodKey: current,
        label: monthLabel(current),
        /** Positive: the group owes you this month. Negative: you owe. */
        net: money(currentNet, currency),
        people: dues$
          .byCounterparty(dues.filter((due) => due.periodKey === current), me)
          .map((person) => personDTO(person, nameMap, currency)),
      },
      previous: {
        iOwe: money(people.reduce((sum, p) => sum + p.iOwe.amountMinor, 0), currency),
        owedToMe: money(people.reduce((sum, p) => sum + p.owedToMe.amountMinor, 0), currency),
        people,
      },
    };
  }

  return {
    cycle: describeCycle(group, now),
    currentPeriodKey: current,
    previousTotal: money(dues$.sumMinor(previousDues), currency),
    periods,
    mine,
    requests: requests.map((request) => requestDTO(request, nameMap, currency, member?._id)),
  };
};

/**
 * The few figures the dashboard header needs, for groupService.getSummary —
 * without the full breakdown `getDues` builds.
 */
const summaryFor = async (group, member, now = new Date()) => {
  const cycle = describeCycle(group, now);
  if (!dues$.isMonthly(group)) return { ...cycle, hasOpenDues: null, mine: null };

  const current = cycle.currentPeriod.periodKey;
  const dues = await computeDues(group._id);
  const me = member ? String(member._id) : null;

  let mine = null;
  if (me) {
    const previous = dues.filter((due) => due.periodKey < current);
    mine = {
      currentNet: money(dues$.netsForPeriod(dues, current).get(me) || 0, group.currency),
      previousIOwe: money(dues$.sumMinor(previous.filter((due) => due.fromMemberId === me)), group.currency),
      previousOwedToMe: money(dues$.sumMinor(previous.filter((due) => due.toMemberId === me)), group.currency),
    };
  }

  return { ...cycle, hasOpenDues: dues.length > 0, mine };
};

/* ------------------------- Offsets and merges ---------------------------- */

/**
 * Write the two halves of an OFFSET or CARRY_FORWARD.
 *
 * In a transaction where the deployment has one. Where it does not, a failure on
 * the second half removes the first — one half on its own would be a real-looking
 * payment that never happened.
 */
const writePair = async ({ group, actor, method, rows, note = "", session = null }) => {
  const pairId = crypto.randomUUID();
  const payloads = rows.map((row) => ({
    groupId: group._id,
    fromMemberId: row.fromMemberId,
    toMemberId: row.toMemberId,
    amountMinor: row.amountMinor,
    currencyCode: group.currency,
    method,
    note,
    settledAt: new Date(),
    recordedByMemberId: actor._id,
    allocations: row.allocations,
    pairId,
  }));

  try {
    await settlementRepository.createPair(payloads, session);
  } catch (err) {
    if (!session) await settlementRepository.deleteByPairId(group._id, pairId).catch(() => null);
    throw err;
  }

  return pairId;
};

/**
 * `POST /groups/:code/dues/offset` — cancel opposite debts between the actor and
 * one other person.
 *
 * Unilateral, unlike a merge, because nobody is worse off: A2 gives up ₹100 of
 * what A3 owed for September and in exchange no longer owes A3 ₹100 for October.
 * Each side's position moves by the same amount in opposite directions. It is
 * still an explicit action, recorded and announced, never something the app does
 * on its own (PRD §13).
 */
const offsetDues = async ({ group, actor, dto }) => {
  assertMonthly(group);
  const counterparty = await loadCounterparty(group, actor, dto.counterpartyMemberId);

  const dues = await computeDuesFresh(group._id);
  const plan = dues$.planOffset({
    dues,
    aMemberId: String(actor._id),
    bMemberId: String(counterparty._id),
    amountMinor: dto.amount !== undefined ? toMinor(dto.amount, group.currency) : undefined,
  });

  if (!plan) {
    throw new BadRequestError(
      `You and ${counterparty.name} do not owe each other in opposite directions, so there is nothing to offset.`,
      ERROR_CODES.NOTHING_OWED
    );
  }

  const pairId = await writePair({
    group,
    actor,
    method: SETTLEMENT_METHODS.OFFSET,
    note: dto.note || "",
    rows: [
      { fromMemberId: actor._id, toMemberId: counterparty._id, amountMinor: plan.amountMinor, allocations: plan.aToB },
      { fromMemberId: counterparty._id, toMemberId: actor._id, amountMinor: plan.amountMinor, allocations: plan.bToA },
    ],
  });

  const formatted = formatMinor(plan.amountMinor, group.currency);
  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.DUES_OFFSET,
    actor,
    message: `${actor.name} offset ${formatted} between ${actor.name} and ${counterparty.name}`,
    metadata: { pairId, amountMinor: plan.amountMinor, counterpartyId: String(counterparty._id) },
  });

  pushService
    .notifyMembers({
      group,
      memberIds: [counterparty._id],
      type: ACTIVITY_TYPES.DUES_OFFSET,
      body: `${actor.name} offset ${formatted} of what you two owe each other`,
    })
    .catch(() => null);

  return { offset: money(plan.amountMinor, group.currency), pairId, dues: await getDues(group, actor) };
};

/* ------------------------------- Requests -------------------------------- */

/**
 * `POST /groups/:code/dues/requests`
 *
 *   PAYMENT  sent by the creditor: "you owe me ₹1,300 from earlier months".
 *   MERGE    sent by either side: "move this due into the current month and
 *            we will settle it through this month's spending" — the A1/A2 → A4
 *            case. Takes effect only when the other side accepts.
 */
const createRequest = async ({ group, actor, dto }) => {
  assertMonthly(group);
  const counterparty = await loadCounterparty(group, actor, dto.counterpartyMemberId);
  const me = String(actor._id);
  const them = String(counterparty._id);
  const current = currentPeriodKey();
  const dues = await computeDuesFresh(group._id);

  const iOwe = dues$.owedBetween(dues, me, them, { before: current });
  const theyOwe = dues$.owedBetween(dues, them, me, { before: current });

  let fromMemberId;
  let toMemberId;

  if (dto.kind === DUE_REQUEST_KINDS.PAYMENT) {
    // Only a creditor asks to be paid.
    fromMemberId = them;
    toMemberId = me;
  } else if (dto.direction === "I_OWE" || (!dto.direction && iOwe.length > 0 && theyOwe.length === 0)) {
    fromMemberId = me;
    toMemberId = them;
  } else if (dto.direction === "OWED_TO_ME" || (!dto.direction && theyOwe.length > 0 && iOwe.length === 0)) {
    fromMemberId = them;
    toMemberId = me;
  } else if (iOwe.length > 0 && theyOwe.length > 0) {
    throw new BadRequestError(
      `You and ${counterparty.name} each owe the other from earlier months — say which due to merge, or offset them instead.`,
      ERROR_CODES.VALIDATION_ERROR
    );
  } else {
    fromMemberId = me;
    toMemberId = them;
  }

  const owed = fromMemberId === me ? iOwe : theyOwe;
  const available = dues$.sumMinor(owed);

  if (available === 0) {
    throw new BadRequestError(
      dto.kind === DUE_REQUEST_KINDS.PAYMENT
        ? `${counterparty.name} does not owe you anything from earlier months.`
        : "There is no previous-month due between you two to merge.",
      ERROR_CODES.NOTHING_OWED
    );
  }

  const asked = dto.amount !== undefined ? toMinor(dto.amount, group.currency) : available;
  if (asked > available) {
    throw new BadRequestError(
      `That is more than the ${formatMinor(available, group.currency)} owed from earlier months.`,
      ERROR_CODES.INVALID_AMOUNT
    );
  }

  const existing = await dueRequestRepository.findPending(group._id, { kind: dto.kind, fromMemberId, toMemberId });
  if (existing) {
    const error = new ConflictError("There is already an open request for this", ERROR_CODES.DUE_REQUEST_EXISTS);
    error.details = { requestId: String(existing._id) };
    throw error;
  }

  let request;
  try {
    request = await dueRequestRepository.create({
      groupId: group._id,
      kind: dto.kind,
      fromMemberId,
      toMemberId,
      requestedByMemberId: me,
      respondentMemberId: them,
      amountMinor: asked,
      breakdown: owed,
      targetPeriodKey: dto.kind === DUE_REQUEST_KINDS.MERGE ? current : null,
      note: dto.note || "",
    });
  } catch (err) {
    // Lost the race to the partial unique index — the other tap won.
    if (err?.code === 11000) {
      throw new ConflictError("There is already an open request for this", ERROR_CODES.DUE_REQUEST_EXISTS);
    }
    throw err;
  }

  const formatted = formatMinor(asked, group.currency);
  const months = owed.map((row) => monthLabel(row.periodKey)).join(", ");
  const message =
    dto.kind === DUE_REQUEST_KINDS.PAYMENT
      ? `${actor.name} requested ${formatted} from ${counterparty.name} for ${months}`
      : `${actor.name} asked ${counterparty.name} to merge ${formatted} from ${months} into ${monthLabel(current)}`;

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.DUE_REQUESTED,
    actor,
    message,
    metadata: { requestId: String(request._id), kind: dto.kind, amountMinor: asked },
  });

  pushService
    .notifyMembers({
      group,
      memberIds: [them],
      type: ACTIVITY_TYPES.DUE_REQUESTED,
      tag: `${group.inviteCode}:due:${request._id}`,
      query: `&request=${request._id}`,
      body:
        dto.kind === DUE_REQUEST_KINDS.PAYMENT
          ? `${actor.name} requested ${formatted} from you for ${months}`
          : `${actor.name} asked to move ${formatted} from ${months} into ${monthLabel(current)}`,
    })
    .catch(() => null);

  const nameMap = await memberService.buildNameMap(group._id);
  return requestDTO({ ...request.toObject(), outstandingMinor: available }, nameMap, group.currency, me);
};

/** `GET /groups/:code/dues/requests` — open ones, then the viewer's recent history. */
const listRequests = async (group, member) => {
  assertMonthly(group);
  const dues = await computeDues(group._id);
  // Refresh first: history read alongside it could still show a request as
  // PENDING that the refresh has just resolved, and it would fall out of both lists.
  const live = await refreshRequests(group, dues, currentPeriodKey());
  const [history, nameMap] = await Promise.all([
    dueRequestRepository.listInvolving(group._id, member._id),
    memberService.buildNameMap(group._id),
  ]);

  const liveIds = new Set(live.map((request) => String(request._id)));
  return {
    open: live.map((request) => requestDTO(request, nameMap, group.currency, member._id)),
    history: history
      .filter((request) => !liveIds.has(String(request._id)) && request.status !== DUE_REQUEST_STATUS.PENDING)
      .map((request) => requestDTO(request, nameMap, group.currency, member._id)),
  };
};

const acceptMerge = async ({ group, actor, request }) => {
  const current = currentPeriodKey();

  if (request.targetPeriodKey !== current) {
    await dueRequestRepository.decide(group._id, request._id, DUE_REQUEST_STATUS.EXPIRED);
    throw new ConflictError(
      `This was a request to merge into ${monthLabel(request.targetPeriodKey)}, which has ended. Ask again for this month.`,
      ERROR_CODES.DUE_REQUEST_ALREADY_DECIDED
    );
  }

  const dues = await computeDuesFresh(group._id);
  const plan = dues$.planMerge({
    dues,
    fromMemberId: String(request.fromMemberId),
    toMemberId: String(request.toMemberId),
    amountMinor: request.amountMinor,
    currentPeriodKey: current,
  });

  if (!plan) {
    await dueRequestRepository.decide(group._id, request._id, DUE_REQUEST_STATUS.RESOLVED);
    throw new BadRequestError("That due has already been settled — there is nothing left to merge.", ERROR_CODES.NOTHING_OWED);
  }

  const debtor = request.fromMemberId;
  const creditor = request.toMemberId;

  const pairId = await withTransaction(async (session) => {
    // Claim the request first: only the call that wins this writes anything.
    const claimed = await dueRequestRepository.decide(group._id, request._id, DUE_REQUEST_STATUS.ACCEPTED, {}, session);
    if (!claimed) {
      throw new ConflictError("This request has already been answered", ERROR_CODES.DUE_REQUEST_ALREADY_DECIDED);
    }

    try {
      const id = await writePair({
        group,
        actor,
        session,
        method: SETTLEMENT_METHODS.CARRY_FORWARD,
        note: request.note || "",
        rows: [
          // Clears the earlier months…
          { fromMemberId: debtor, toMemberId: creditor, amountMinor: plan.amountMinor, allocations: plan.clearing },
          // …and re-creates the same debt in this one.
          { fromMemberId: creditor, toMemberId: debtor, amountMinor: plan.amountMinor, allocations: plan.carrying },
        ],
      });
      return id;
    } catch (err) {
      // No transaction to roll back: hand the request back so it can be retried.
      if (!session) await dueRequestRepository.reopen(group._id, request._id).catch(() => null);
      throw err;
    }
  });

  await dueRequestRepository.setPairId(group._id, request._id, pairId).catch(() => null);

  const nameMap = await memberService.buildNameMap(group._id);
  const debtorName = nameMap.get(String(debtor)) || "Someone";
  const creditorName = nameMap.get(String(creditor)) || "someone";
  const formatted = formatMinor(plan.amountMinor, group.currency);
  const months = plan.clearing.map((row) => monthLabel(row.periodKey)).join(", ");

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.DUE_MERGED,
    actor,
    message: `${debtorName}'s ${formatted} owed to ${creditorName} from ${months} was merged into ${monthLabel(current)}`,
    metadata: { requestId: String(request._id), pairId, amountMinor: plan.amountMinor },
  });

  pushService
    .notifyMembers({
      group,
      memberIds: [request.requestedByMemberId],
      type: ACTIVITY_TYPES.DUE_MERGED,
      body: `${actor.name} agreed — ${formatted} from ${months} is now part of ${monthLabel(current)}`,
    })
    .catch(() => null);

  return { status: DUE_REQUEST_STATUS.ACCEPTED, merged: money(plan.amountMinor, group.currency), pairId };
};

/**
 * `POST /groups/:code/dues/requests/:requestId` with `{ action }`.
 *
 *   accept   MERGE only, by the person it is addressed to
 *   decline  by the person it is addressed to
 *   cancel   by whoever sent it
 *
 * A PAYMENT has no "accept": the answer to "please pay me" is a payment, which
 * goes through the ordinary settlement route and resolves the request by itself.
 */
const respondToRequest = async ({ group, actor, requestId, action }) => {
  assertMonthly(group);
  const request = mongoose.isValidObjectId(requestId)
    ? await dueRequestRepository.findById(group._id, requestId)
    : null;
  if (!request) throw new NotFoundError("Request not found", ERROR_CODES.DUE_REQUEST_NOT_FOUND);

  if (request.status !== DUE_REQUEST_STATUS.PENDING) {
    throw new ConflictError("This request has already been answered", ERROR_CODES.DUE_REQUEST_ALREADY_DECIDED);
  }

  const me = String(actor._id);

  if (action === "cancel") {
    if (me !== String(request.requestedByMemberId)) {
      throw new ForbiddenError("Only whoever sent a request can withdraw it", ERROR_CODES.NOT_REQUEST_RECIPIENT);
    }
    const decided = await dueRequestRepository.decide(group._id, requestId, DUE_REQUEST_STATUS.CANCELLED);
    if (!decided) throw new ConflictError("This request has already been answered", ERROR_CODES.DUE_REQUEST_ALREADY_DECIDED);
    await activityService.record({
      groupId: group._id,
      type: ACTIVITY_TYPES.DUE_REQUEST_CANCELLED,
      actor,
      message: `${actor.name} withdrew a ${request.kind === DUE_REQUEST_KINDS.MERGE ? "merge" : "payment"} request`,
      metadata: { requestId: String(request._id) },
    });
    return { status: DUE_REQUEST_STATUS.CANCELLED };
  }

  if (me !== String(request.respondentMemberId)) {
    throw new ForbiddenError("Only the person this request was sent to can answer it", ERROR_CODES.NOT_REQUEST_RECIPIENT);
  }

  if (action === "decline") {
    const decided = await dueRequestRepository.decide(group._id, requestId, DUE_REQUEST_STATUS.DECLINED);
    if (!decided) throw new ConflictError("This request has already been answered", ERROR_CODES.DUE_REQUEST_ALREADY_DECIDED);
    await activityService.record({
      groupId: group._id,
      type: ACTIVITY_TYPES.DUE_REQUEST_DECLINED,
      actor,
      message: `${actor.name} declined a ${request.kind === DUE_REQUEST_KINDS.MERGE ? "merge" : "payment"} request`,
      metadata: { requestId: String(request._id) },
    });
    pushService
      .notifyMembers({
        group,
        memberIds: [request.requestedByMemberId],
        type: ACTIVITY_TYPES.DUE_REQUEST_DECLINED,
        body: `${actor.name} declined your ${request.kind === DUE_REQUEST_KINDS.MERGE ? "merge" : "payment"} request`,
      })
      .catch(() => null);
    return { status: DUE_REQUEST_STATUS.DECLINED };
  }

  if (request.kind !== DUE_REQUEST_KINDS.MERGE) {
    throw new BadRequestError(
      "A payment request is answered by paying it — record the payment and the request closes itself.",
      ERROR_CODES.VALIDATION_ERROR
    );
  }

  return acceptMerge({ group, actor, request });
};

/* ---------------------------- Close and reopen ---------------------------- */

/** `POST /groups/:code/close` — creator only (PRD §21). */
const closeGroup = async ({ group, actor }) => {
  assertContinuous(group);
  if (dues$.isClosed(group, new Date(), periodOptions())) {
    throw new ConflictError("This group is already closed", ERROR_CODES.GROUP_CLOSED);
  }

  const updated = await groupRepository.closeIfOpen(group._id, actor._id);
  if (!updated) throw new ConflictError("This group is already closed", ERROR_CODES.GROUP_CLOSED);

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.GROUP_CLOSED,
    actor,
    message: `${actor.name} closed "${group.name}" — no more expenses; settle what is left`,
    metadata: {},
  });

  return toGroupDTO(updated);
};

/**
 * `POST /groups/:code/reopen` — the undo for a close.
 *
 * A group closed by its end date reopens with no end date (or the new one given),
 * otherwise it would close itself again on the next write.
 */
const reopenGroup = async ({ group, actor, endDate }) => {
  assertContinuous(group);
  const now = new Date();
  if (!dues$.isClosed(group, now, periodOptions())) {
    throw new ConflictError("This group is not closed", ERROR_CODES.VALIDATION_ERROR);
  }

  const update = { closedAt: null, closedByMemberId: null, lastActivityAt: now };
  if (endDate !== undefined) update.endDate = endDate;
  else if (!group.closedAt) update.endDate = null;

  const reopened = { ...(typeof group.toObject === "function" ? group.toObject() : group), ...update };
  if (dues$.isClosed(reopened, now, periodOptions())) {
    throw new BadRequestError("That end date has already passed — choose a later one", ERROR_CODES.VALIDATION_ERROR);
  }

  const updated = await groupRepository.updateById(group._id, { $set: update });

  await activityService.record({
    groupId: group._id,
    type: ACTIVITY_TYPES.GROUP_REOPENED,
    actor,
    message: `${actor.name} reopened "${group.name}"`,
    metadata: {},
  });

  return toGroupDTO(updated);
};

/**
 * Close every continuous group past its end date and grace window.
 *
 * Runs on the hourly recurring tick. It only makes the stored state catch up:
 * writes already refuse a group in this state (`isClosed` reads the date), so a
 * late or missed sweep changes what the group *says*, never what it allows.
 * Idempotent through `closeIfOpen`.
 */
const closeEndedGroups = async (now = new Date()) => {
  const { graceDays, timeZone } = periodOptions();
  const today = localDateString(now, timeZone);
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - graceDays * 86_400_000);

  const groups = await groupRepository.findEndedOpenTrips(cutoff);
  let closed = 0;

  for (const group of groups) {
    // eslint-disable-next-line no-await-in-loop -- bounded batch
    const updated = await groupRepository.closeIfOpen(group._id, null);
    if (!updated) continue;
    closed += 1;
    // eslint-disable-next-line no-await-in-loop
    await activityService.record({
      groupId: group._id,
      type: ACTIVITY_TYPES.GROUP_CLOSED,
      actor: null,
      message: `"${group.name}" closed after its end date — settle what is left`,
      metadata: { automatic: true },
    });
  }

  if (closed > 0) logger.info(`[cycles] Closed ${closed} group(s) past their end date`);
  return { closed };
};

module.exports = {
  currentPeriodKey,
  computeDues,
  computeDuesFresh,
  allocationsFor,
  suggestionsFor,
  getCycle,
  getDues,
  summaryFor,
  offsetDues,
  createRequest,
  listRequests,
  respondToRequest,
  closeGroup,
  reopenGroup,
  closeEndedGroups,
  monthLabel,
};
