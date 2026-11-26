/**
 * Monthly and continuous balance cycles, end to end against a real database
 * (docs/29-BALANCE-CYCLES.md).
 *
 *   npm run cycles:check
 *
 * The arithmetic has unit tests (tests/periodDues.test.js). This covers what they
 * cannot: the month aggregation running in Mongo in the configured zone, the
 * paired settlement writes, the request lifecycle, and the guards on expenses.
 *
 * Creates two throwaway groups and deletes everything it made, pass or fail.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const config = require("../src/config/env");
const groupService = require("../src/services/groupService");
const expenseService = require("../src/services/expenseService");
const settlementService = require("../src/services/settlementService");
const cycleService = require("../src/services/cycleService");
const groupRepository = require("../src/repositories/groupRepository");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Expense = require("../src/models/expense");
const Settlement = require("../src/models/settlement");
const DueRequest = require("../src/models/dueRequest");
const Activity = require("../src/models/activity");
const { previousMonthKey } = require("../src/utils/expensePeriod");

let failures = 0;
const check = (label, actual, want) => {
  const pass = JSON.stringify(actual) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`);
};

const refuses = async (fn, code) => {
  try {
    await fn();
    return "accepted";
  } catch (err) {
    return err.code === code ? code : `${err.code}: ${err.message}`;
  }
};

const created = [];

const makeGroup = async (dto) => {
  const result = await groupService.createGroup({ creatorName: "A2", deviceId: `cycles-${Date.now()}`, ...dto });
  const group = await groupRepository.findByInviteCode(result.group.inviteCode);
  created.push(group._id);
  const a2 = await Member.findById(result.member.id).lean();
  const add = (name) => Member.create({ groupId: group._id, name, isActive: true }).then((m) => m.toObject());
  const [a1, a3, a4] = [await add("A1"), await add("A3"), await add("A4")];
  return { group, a1, a2, a3, a4 };
};

/** An expense written straight to the collection — the month lock would refuse a backdated one. */
const backdated = (group, date, paidBy, shares) =>
  Expense.create({
    groupId: group._id,
    description: "backdated",
    amountMinor: Object.values(shares).reduce((a, b) => a + b, 0),
    currencyCode: group.currency,
    paidBy,
    shares: Object.entries(shares).map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
    expenseDate: date,
    createdByMemberId: paidBy,
  });

const owed = (dues, periodKey, from, to) =>
  dues.periods
    .find((p) => p.periodKey === periodKey)
    ?.dues.find((d) => d.from.id === String(from._id) && d.to.id === String(to._id))?.amountMinor || 0;

(async () => {
  await connectDB();

  try {
    const current = cycleService.currentPeriodKey();
    const previous = previousMonthKey(current);
    const midPrevious = new Date(`${previous}-15T06:00:00Z`);
    console.log(`Current month ${current}, previous ${previous}, zone ${config.expensePeriod.timeZone}\n`);

    /* ------------------------------ Monthly ------------------------------ */
    console.log("Monthly group");
    const { group, a1, a2, a3, a4 } = await makeGroup({ name: "cycles check — flat", balanceCycle: "MONTHLY" });
    check("new group is MONTHLY", group.balanceCycle, "MONTHLY");

    // Previous month: A1 and A3 each owe A2 ₹1,000 (PRD §2).
    await backdated(group, midPrevious, a2._id, { [a1._id]: 100000, [a3._id]: 100000 });

    let dues = await cycleService.getDues(group, a2);
    check("A1 owes A2 ₹1,000 for last month", owed(dues, previous, a1, a2), 100000);
    check("A3 owes A2 ₹1,000 for last month", owed(dues, previous, a3, a2), 100000);
    check("A2 is owed ₹2,000 in previous dues", dues.mine.previous.owedToMe.amountMinor, 200000);

    // This month: A3 pays ₹300 split three ways — must not touch last month (PRD §13).
    await expenseService.createExpense({
      group,
      actor: a3,
      dto: { description: "groceries", amount: 300, paidBy: String(a3._id), participantIds: [a1._id, a2._id, a3._id].map(String) },
    });
    dues = await cycleService.getDues(group, a3);
    check("last month is untouched by this month's expense", owed(dues, previous, a3, a2), 100000);
    check("this month A2 owes A3 ₹100", owed(dues, current, a2, a3), 10000);

    // A3 pays A2 ₹1,000 with no month named → oldest first → last month.
    const { settlement } = await settlementService.recordSettlement({
      group,
      actor: a3,
      dto: { fromMemberId: String(a3._id), toMemberId: String(a2._id), amount: 1000, method: "UPI" },
    });
    check("payment allocated to last month", settlement.allocations.map((a) => [a.periodKey, a.amountMinor]), [[previous, 100000]]);
    dues = await cycleService.getDues(group, a3);
    check("A3's previous due is cleared", owed(dues, previous, a3, a2), 0);
    check("this month is still independent", owed(dues, current, a2, a3), 10000);

    // Offset: A1 owes A2 ₹1,000 (previous); make A2 owe A1 ₹150 this month.
    await expenseService.createExpense({
      group,
      actor: a1,
      dto: { description: "taxi", amount: 300, paidBy: String(a1._id), participantIds: [a1._id, a2._id].map(String) },
    });
    const offset = await cycleService.offsetDues({ group, actor: a1, dto: { counterpartyMemberId: String(a2._id) } });
    check("offset cancels the smaller side", offset.offset.amountMinor, 15000);
    check("A1's previous due drops to ₹850", owed(offset.dues, previous, a1, a2), 85000);
    check("the offset wrote a pair of OFFSET rows", await Settlement.countDocuments({ groupId: group._id, method: "OFFSET" }), 2);

    // Merge: A1 asks A2 to fold the remaining ₹850 into this month; A2 accepts.
    const request = await cycleService.createRequest({
      group,
      actor: a1,
      dto: { kind: "MERGE", counterpartyMemberId: String(a2._id) },
    });
    check("merge request is addressed to A2", request.respondent.id, String(a2._id));
    check(
      "a second identical request is refused",
      await refuses(() => cycleService.createRequest({ group, actor: a1, dto: { kind: "MERGE", counterpartyMemberId: String(a2._id) } }), "DUE_REQUEST_EXISTS"),
      "DUE_REQUEST_EXISTS"
    );
    check(
      "only A2 can accept it",
      await refuses(() => cycleService.respondToRequest({ group, actor: a1, requestId: request.id, action: "accept" }), "NOT_REQUEST_RECIPIENT"),
      "NOT_REQUEST_RECIPIENT"
    );
    const accepted = await cycleService.respondToRequest({ group, actor: a2, requestId: request.id, action: "accept" });
    check("merge accepted for ₹850", accepted.merged.amountMinor, 85000);
    check(
      "accepting twice is refused",
      await refuses(() => cycleService.respondToRequest({ group, actor: a2, requestId: request.id, action: "accept" }), "DUE_REQUEST_ALREADY_DECIDED"),
      "DUE_REQUEST_ALREADY_DECIDED"
    );
    dues = await cycleService.getDues(group, a1);
    check("A1's previous due is gone", owed(dues, previous, a1, a2), 0);
    check("…and carried into this month", owed(dues, current, a1, a2), 85000);

    // Payment request: A4 is owed by A1 for last month; asks; A1 pays; it resolves.
    await backdated(group, midPrevious, a4._id, { [a1._id]: 50000 });
    const ask = await cycleService.createRequest({ group, actor: a4, dto: { kind: "PAYMENT", counterpartyMemberId: String(a1._id) } });
    check("payment request for ₹500", ask.requested.amountMinor, 50000);
    await settlementService.recordSettlement({
      group,
      actor: a1,
      dto: { fromMemberId: String(a1._id), toMemberId: String(a4._id), amount: 500, method: "CASH" },
    });
    const requests = await cycleService.listRequests(group, a4);
    check("paid request resolves itself", requests.history.find((r) => r.id === ask.id)?.status, "RESOLVED");

    // Summary and settle-up agree with the dues.
    const summary = await groupService.getSummary(group, a1);
    check("summary carries the cycle", summary.cycle.type, "MONTHLY");
    const suggestions = await settlementService.getSuggestions(group, a1);
    check("settle-up lists real pairs with months", suggestions.transfers.every((t) => Array.isArray(t.periods)), true);

    check(
      "the cycle cannot change once there are expenses",
      await refuses(() => groupService.updateGroup({ group, actor: a2, balanceCycle: "CONTINUOUS" }), "CYCLE_LOCKED"),
      "CYCLE_LOCKED"
    );

    /* ----------------------------- Continuous ---------------------------- */
    console.log("\nContinuous group");
    const trip = await makeGroup({
      name: "cycles check — trip",
      balanceCycle: "CONTINUOUS",
      startDate: new Date(`${previous}-25T00:00:00Z`),
      endDate: new Date(`${current}-28T00:00:00Z`),
    });
    check("new group is CONTINUOUS", trip.group.balanceCycle, "CONTINUOUS");

    // A last-month expense can still be added — no month lock on a continuous split.
    const lastMonth = new Date(`${previous}-26T06:00:00Z`);
    check(
      "a last-month expense is accepted",
      await refuses(() =>
        expenseService.createExpense({
          group: trip.group,
          actor: trip.a2,
          dto: { description: "hotel", amount: 600, paidBy: String(trip.a2._id), participantIds: [trip.a1._id, trip.a2._id].map(String), expenseDate: lastMonth },
        })
      ),
      "accepted"
    );
    check(
      "dues are a monthly-only idea",
      await refuses(() => cycleService.getDues(trip.group, trip.a2), "NOT_MONTHLY"),
      "NOT_MONTHLY"
    );

    await cycleService.closeGroup({ group: trip.group, actor: trip.a2 });
    const closed = await groupRepository.findByInviteCode(trip.group.inviteCode);
    check(
      "a closed group refuses expenses",
      await refuses(() =>
        expenseService.createExpense({
          group: closed,
          actor: trip.a2,
          dto: { description: "late taxi", amount: 100, paidBy: String(trip.a2._id), participantIds: [String(trip.a1._id)] },
        }),
        "GROUP_CLOSED"
      ),
      "GROUP_CLOSED"
    );
    check(
      "…but still takes settlements",
      await refuses(() =>
        settlementService.recordSettlement({
          group: closed,
          actor: trip.a1,
          dto: { fromMemberId: String(trip.a1._id), toMemberId: String(trip.a2._id), amount: 300, method: "UPI" },
        })
      ),
      "accepted"
    );
    const reopened = await cycleService.reopenGroup({ group: closed, actor: trip.a2 });
    check("reopen clears the close", reopened.isClosed, false);
  } catch (err) {
    failures += 1;
    console.error(`\n  ERROR  ${err.stack || err.message}`);
  } finally {
    await Promise.all([
      Group.deleteMany({ _id: { $in: created } }),
      Member.deleteMany({ groupId: { $in: created } }),
      Expense.deleteMany({ groupId: { $in: created } }),
      Settlement.deleteMany({ groupId: { $in: created } }),
      DueRequest.deleteMany({ groupId: { $in: created } }),
      Activity.deleteMany({ groupId: { $in: created } }),
    ]);
    console.log(`\n${failures === 0 ? "All checks passed" : `${failures} check(s) failed`} — test data removed.`);
    await mongoose.disconnect();
    process.exit(failures === 0 ? 0 : 1);
  }
})();
