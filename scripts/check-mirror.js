/**
 * Group expenses mirrored into the personal ledger, and the two AI price tiers.
 *
 *   node scripts/check-mirror.js
 *
 * Writes and removes its own throwaway group, account and ledger.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const memberService = require("../src/services/memberService");
const expenseService = require("../src/services/expenseService");
const ledgerService = require("../src/services/ledgerService");
const assistantService = require("../src/services/ai/assistantService");
const User = require("../src/models/user");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Expense = require("../src/models/expense");
const Activity = require("../src/models/activity");
const Ledger = require("../src/models/ledger");
const LedgerEntry = require("../src/models/ledgerEntry");
const PointEvent = require("../src/models/pointEvent");
const config = require("../src/config/env");
const { POINTS } = require("../src/constants");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${actual}, want ${want})`}`
  );

(async () => {
  await connectDB();

  const stamp = Date.now();
  const device = `mirror-device-${stamp}`;
  const user = await User.create({
    firebaseUid: `mirror-${stamp}`,
    email: "mirror@example.com",
    deviceIds: [device],
  });

  const created = await groupService.createGroup({
    name: "Goa trip",
    currency: "INR",
    creatorName: "Me",
    deviceId: device,
  });

  const groupId = created.group?.id || created.group?._id || created.id || created._id;
  const full = await Group.findById(groupId);
  const firstMembers = await Member.find({ groupId: full._id }).lean();
  const meDoc = firstMembers.find((m) => (m.deviceIds || []).includes(device)) || firstMembers[0];

  for (const name of ["Riya", "Sam", "Dev"]) {
    await memberService.addMember({ group: full, actor: meDoc, name });
  }

  const members = await Member.find({ groupId: full._id, isDeleted: { $ne: true } }).lean();
  const me = members.find((m) => String(m._id) === String(meDoc._id));
  const others = members.filter((m) => String(m._id) !== String(me._id));
  console.log(`(group has ${members.length} members)\n`);

  // A baseline, so "did the mirror log anything?" is a delta rather than a guess
  // at how many rows group setup happens to write.
  const activityBefore = await Activity.countDocuments({ groupId: full._id });

  console.log("--- my share is mirrored, not the amount I fronted ---");
  const { expense } = await expenseService.createExpense({
    group: full,
    actor: me,
    dto: {
      description: "Dinner",
      amount: "1000",
      paidBy: String(me._id),
      participantIds: members.map((m) => String(m._id)),
      splitType: "EQUAL",
    },
  });
  await sleep(600);

  const ledger = await Ledger.findOne({ userId: user._id });
  let mirror = await LedgerEntry.findOne({ ledgerId: ledger._id, sourceExpenseId: expense.id });
  check("a mirror exists", Boolean(mirror), true);
  check("it holds my share (25000), not the 100000 I paid", mirror.amountMinor, 25000);
  check("it is typed as a spend", mirror.type, "SPEND");
  check("it is labelled with the group", mirror.sourceGroupName, "Goa trip");
  check("it is marked as mirrored", mirror.source, "GROUP_EXPENSE");

  console.log("\n--- the category is inferred at write time and inherited ---");
  check("the mirror is categorised", mirror.category, "FOOD");
  // Stored on the expense too, because a category has to be a WHERE clause for
  // the group list's filter to work — the mirror inherits rather than re-derives.
  const storedExpense = await Expense.findById(expense.id).lean();
  check("the group expense carries it as well", storedExpense.category, "FOOD");

  const { inferCategory } = require("../src/utils/inferCategory");
  check("'Auto to station' → TRAVEL", inferCategory("Auto to station"), "TRAVEL");
  check("'Zepto groceries' → FOOD", inferCategory("Zepto groceries"), "FOOD");
  check("'Electricity bill' → BILLS", inferCategory("Electricity bill"), "BILLS");
  check("'Movie tickets' → ENTERTAINMENT", inferCategory("Movie tickets"), "ENTERTAINMENT");
  check("'Flight to Goa' → TRAVEL, not a taxi", inferCategory("Flight to Goa"), "TRAVEL");
  check("an unrecognised word stays blank, not OTHER", inferCategory("xyzzy"), "");
  check("an explicit category always wins", inferCategory("Dinner", "RENT"), "RENT");

  console.log("\n--- and it does not pay points twice ---");
  check(
    "one ACTIVE_DAY for the whole action",
    await PointEvent.countDocuments({ userId: user._id, type: "ACTIVE_DAY" }),
    1
  );

  console.log("\n--- and it is silent: no extra activity, so no extra notification ---");
  const activities = await Activity.find({ groupId: full._id }).lean();
  const added = activities.filter((a) => a.type === "EXPENSE_ADDED");
  check("exactly one activity for the expense", added.length, 1);
  check("the mirror logged nothing of its own", activities.length - activityBefore, 1);
  // The reminder sweep looks for dueAt; a mirrored spend must never enter it.
  check("mirror carries no due date, so no reminder", mirror.dueAt, null);

  console.log("\n--- the two halves are separable, and add up ---");
  const ledgerService2 = require("../src/services/ledgerService");
  const summaryNow = await ledgerService2.getSummary(user._id);
  const t = summaryNow.totals;
  check(
    "own + group equals the total spent",
    t.spentOwnMinor + t.spentGroupMinor,
    t.spentMinor
  );
  check("this expense counts as group spending", t.spentGroupCount, 1);
  check("nothing was typed by hand", t.spentOwnCount, 0);

  const groupOnly = await ledgerService2.listEntries(user._id, { source: "GROUP_EXPENSE" });
  const manualOnly = await ledgerService2.listEntries(user._id, { source: "MANUAL" });
  check("the group tab has the mirror", groupOnly.items.length, 1);
  check("the personal tab does not", manualOnly.items.length, 0);
  check("and it is labelled with its group", groupOnly.items[0].fromGroup, "Goa trip");

  console.log("\n--- editing the split re-derives the share ---");
  await expenseService.updateExpense({
    group: full,
    actor: me,
    expenseId: expense.id,
    dto: {
      description: "Dinner",
      amount: "1000",
      paidBy: String(me._id),
      participantIds: [String(me._id), String(others[0]._id), String(others[1]._id)],
      splitType: "EQUAL",
      version: 0,
    },
  });
  await sleep(600);
  mirror = await LedgerEntry.findById(mirror._id);
  console.log(`  share is now ${mirror.amountMinor} minor units`);
  check("the mirror followed the split, not the total", mirror.amountMinor > 25000, true);

  console.log("\n--- being removed from the split removes the row ---");
  await expenseService.updateExpense({
    group: full,
    actor: me,
    expenseId: expense.id,
    dto: {
      description: "Dinner",
      amount: "1000",
      paidBy: String(me._id),
      participantIds: [String(others[0]._id), String(others[1]._id)],
      splitType: "EQUAL",
      version: 1,
    },
  });
  await sleep(600);
  mirror = await LedgerEntry.findById(mirror._id);
  check("soft-deleted when my share is zero", mirror.isDeleted, true);

  console.log("\n--- a mirrored row cannot be edited from the ledger ---");
  const { expense: second } = await expenseService.createExpense({
    group: full,
    actor: me,
    dto: {
      description: "Taxi",
      amount: "400",
      paidBy: String(others[0]._id),
      participantIds: members.map((m) => String(m._id)),
      splitType: "EQUAL",
    },
  });
  await sleep(600);
  const taxi = await LedgerEntry.findOne({ ledgerId: ledger._id, sourceExpenseId: second.id });
  check("mirrored even when someone else paid", Boolean(taxi), true);
  check("my share of 400 split four ways", taxi.amountMinor, 10000);

  let refused = false;
  try {
    await ledgerService.updateEntry(user._id, String(taxi._id), { amount: "999", version: 0 });
  } catch (err) {
    refused = err.code === "LEDGER_ENTRY_NOT_EDITABLE";
  }
  check("editing it is refused with a reason", refused, true);

  console.log("\n--- deleting the group expense removes the personal copy ---");
  await expenseService.deleteExpense({ group: full, actor: me, expenseId: second.id });
  await sleep(500);
  check("mirror soft-deleted with the expense", (await LedgerEntry.findById(taxi._id)).isDeleted, true);

  console.log("\n--- a member with no account gets no ledger written ---");
  const before = await Ledger.countDocuments({ userId: { $ne: user._id } });
  await expenseService.createExpense({
    group: full,
    actor: others[0],
    dto: {
      description: "Snacks",
      amount: "200",
      paidBy: String(others[0]._id),
      participantIds: members.map((m) => String(m._id)),
      splitType: "EQUAL",
    },
  });
  await sleep(600);
  check(
    "no ledger created for a signed-out member",
    await Ledger.countDocuments({ userId: { $ne: user._id } }),
    before
  );

  console.log("\n--- AI pricing tiers ---");
  const day = 24 * 3600 * 1000;
  const fresh = { _id: user._id, createdAt: new Date() };
  const old = { _id: user._id, createdAt: new Date(Date.now() - 60 * day) };
  const boundary = { _id: user._id, createdAt: new Date(Date.now() - (config.ai.newUserDays + 1) * day) };

  const freshStatus = await assistantService.status(fresh);
  const oldStatus = await assistantService.status(old);

  check("new account: free questions", freshStatus.limit, config.ai.newUserQuota);
  check("new account: point price", freshStatus.pointCost, POINTS.AI_QUESTION_COST_NEW);
  check("new account is flagged", freshStatus.newAccount, true);
  check("established: free questions", oldStatus.limit, config.ai.dailyQuota);
  check("established: point price", oldStatus.pointCost, POINTS.AI_QUESTION_COST);
  check("established is not flagged", oldStatus.newAccount, false);
  check(
    `an account older than ${config.ai.newUserDays} days pays full price`,
    (await assistantService.status(boundary)).pointCost,
    POINTS.AI_QUESTION_COST
  );

  console.log("\n--- cleanup ---");
  await LedgerEntry.deleteMany({ ledgerId: ledger._id });
  await Ledger.deleteOne({ _id: ledger._id });
  await Expense.deleteMany({ groupId: full._id });
  await Activity.deleteMany({ groupId: full._id });
  await Member.deleteMany({ groupId: full._id });
  await Group.deleteOne({ _id: full._id });
  await PointEvent.deleteMany({ userId: user._id });
  await User.deleteOne({ _id: user._id });
  console.log("  done");
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
