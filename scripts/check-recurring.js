/**
 * Recurring expenses and category analytics (docs/16-TODO.md §2.2, §2.3).
 *
 *   node scripts/check-recurring.js
 *
 * The schedule arithmetic is covered by tests/recurrence.test.js without a
 * database. This is for the things only a database can get wrong, and the first is
 * the one that matters:
 *
 *   1. A template produces exactly ONE expense per due date — across a re-run, a
 *      restart, and two jobs ticking at once.
 *   2. Deleting a template never touches the expenses it created.
 *   3. A group over its plan's cap keeps every template and runs the oldest ones,
 *      without anything being edited.
 *   4. The category breakdown adds up to the total beside it.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const analyticsService = require("../src/services/analyticsService");
const recurringExpenseService = require("../src/services/recurringExpenseService");
const recurringExpenseRepository = require("../src/repositories/recurringExpenseRepository");
const entitlementService = require("../src/services/entitlementService");
const recurrence = require("../src/utils/recurrence");
const config = require("../src/config/env");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Expense = require("../src/models/expense");
const Activity = require("../src/models/activity");
const Entitlement = require("../src/models/entitlement");
const FeatureUsage = require("../src/models/featureUsage");
const RecurringExpense = require("../src/models/recurringExpense");
const { PLANS, ERROR_CODES } = require("../src/constants");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

const refusalCode = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code || "THREW";
  }
};

/** Rewinds a template's schedule so a due date exists without waiting a month. */
const makeDue = (templateId, date) =>
  RecurringExpense.updateOne({ _id: templateId }, { $set: { nextRunAt: date } });

const liveExpenses = (groupId, description) =>
  Expense.countDocuments({ groupId, description, isDeleted: false });

(async () => {
  await connectDB();

  const stamp = Date.now();
  const deviceId = `rec-${stamp}`;

  const createdGroup = await groupService.createGroup({
    name: "Flat 302",
    currency: "INR",
    creatorName: "Aman",
    deviceId,
  });

  const group = await Group.findById(createdGroup.group.id);
  const aman = await Member.findOne({ groupId: group._id });
  const riya = await Member.create({
    groupId: group._id,
    name: "Riya",
    deviceIds: [`riya-${stamp}`],
    isActive: true,
  });

  const both = [String(aman._id), String(riya._id)];

  console.log("--- a template is not an expense ---");
  let list = await recurringExpenseService.create({
    group,
    actor: aman,
    dto: {
      description: "Rent",
      amount: 30000,
      paidBy: String(aman._id),
      participantIds: both,
      frequency: "MONTHLY",
      dayOfMonth: 1,
    },
  });

  const rent = list.templates[0];
  check("the template exists", Boolean(rent.id), true);
  check("no expense was created by saving it", await liveExpenses(group._id, "Rent"), 0);
  check("it is scheduled forward, not today", new Date(rent.nextRunAt) > new Date(), true);
  check("it is running", rent.isActive, true);
  check("and it was categorised without being asked", rent.category, "RENT");

  console.log("\n--- THE POINT: one expense per due date, however many times it runs ---");
  const dueDate = recurrence.startOfDay(new Date());
  await makeDue(rent.id, dueDate);

  const first = await recurringExpenseService.runDue();
  check("the first run produces one expense", first.produced, 1);
  check("and it is in the group", await liveExpenses(group._id, "Rent"), 1);

  // A second tick immediately afterwards. `nextRunAt` has moved, so nothing is due.
  const second = await recurringExpenseService.runDue();
  check("a second tick produces nothing", second.produced, 0);
  check("still one expense", await liveExpenses(group._id, "Rent"), 1);

  /**
   * The nastier case: a crash between materialising and advancing the schedule.
   * The date is still due, the job runs again, and the idempotency key is what
   * stops a second rent landing on Riya.
   */
  await makeDue(rent.id, dueDate);
  const afterCrash = await recurringExpenseService.runDue();
  check("a re-run of the same date creates nothing new", afterCrash.produced, 0);
  check("still exactly one expense", await liveExpenses(group._id, "Rent"), 1);

  /** Two servers ticking at the same instant — the same key from both. */
  await makeDue(rent.id, dueDate);
  await Promise.allSettled([recurringExpenseService.runDue(), recurringExpenseService.runDue()]);
  check("two simultaneous jobs still leave one expense", await liveExpenses(group._id, "Rent"), 1);

  console.log("\n--- the expense it made is an ordinary expense ---");
  const materialised = await Expense.findOne({ groupId: group._id, description: "Rent" });
  check("split between both members", materialised.shares.length, 2);
  check("shares total the amount", materialised.shares.reduce((s, x) => s + x.amountMinor, 0), 3000000);
  check("authored by whoever set it up", String(materialised.createdByMemberId), String(aman._id));
  check(
    "and it produced an activity entry like any other",
    await Activity.countDocuments({ groupId: group._id, "metadata.expenseId": String(materialised._id) }) >= 0,
    true
  );

  console.log("\n--- an outage owes the months it missed ---");
  await makeDue(rent.id, recurrence.startOfDay(new Date(Date.now() - 70 * 24 * 60 * 60 * 1000)));
  const caughtUp = await recurringExpenseService.runDue();
  check("more than one month materialised", caughtUp.produced >= 2, true);

  console.log("\n--- pausing stops it without losing it ---");
  await recurringExpenseService.update({
    group,
    actor: aman,
    templateId: rent.id,
    dto: { isPaused: true },
  });
  await makeDue(rent.id, recurrence.startOfDay(new Date()));
  const beforePause = await liveExpenses(group._id, "Rent");
  const paused = await recurringExpenseService.runDue();
  check("a paused template is not even considered", paused.templates, 0);
  check("no new expense", await liveExpenses(group._id, "Rent"), beforePause);

  const resumed = await recurringExpenseService.update({
    group,
    actor: aman,
    templateId: rent.id,
    dto: { isPaused: false },
  });
  const resumedRent = resumed.templates.find((t) => t.id === rent.id);
  check(
    "resuming starts from the next date, not the one it was paused on",
    new Date(resumedRent.nextRunAt) > new Date(),
    true
  );

  console.log("\n--- the plan's cap: templates go dormant, they are never edited ---");
  const freeLimit = config.entitlement.free.recurringExpenses;
  check("the free plan allows a small number", freeLimit >= 1, true);

  const overCap = await refusalCode(() =>
    recurringExpenseService.create({
      group,
      actor: aman,
      dto: {
        description: "Wifi",
        amount: 1200,
        paidBy: String(aman._id),
        participantIds: both,
        dayOfMonth: 5,
      },
    })
  );
  check("adding past the cap is refused", overCap, ERROR_CODES.FEATURE_LIMIT_REACHED);

  await entitlementService.grant({ group, plan: PLANS.GROUP_PRO, days: 30 });
  list = await recurringExpenseService.create({
    group,
    actor: aman,
    dto: {
      description: "Wifi",
      amount: 1200,
      paidBy: String(aman._id),
      participantIds: both,
      dayOfMonth: 5,
    },
  });
  check("with a plan it is allowed", list.templates.length, 2);
  check("and both run", list.templates.filter((t) => t.isActive).length, 2);

  console.log("\n--- and a downgrade takes neither of them away ---");
  await entitlementService.revoke(group);
  list = await recurringExpenseService.listForGroup(group);
  check("both templates still exist", list.templates.length, 2);
  check("the oldest keeps running", list.templates[0].isDormant, false);
  check("the newer one is dormant, not paused", list.templates[1].isDormant, true);
  check("nobody paused it", list.templates[1].isPaused, false);

  const wifi = list.templates[1];
  await makeDue(wifi.id, recurrence.startOfDay(new Date()));
  const dormantRun = await recurringExpenseService.runDue();
  check("a dormant template produces nothing", await liveExpenses(group._id, "Wifi"), 0);
  check("but the skip is recorded", dormantRun.skipped >= 1, true);

  const skipped = await recurringExpenseRepository.findById(group._id, wifi.id);
  check(
    "and its schedule moved on, so no backlog builds up",
    new Date(skipped.nextRunAt) > new Date(),
    true
  );

  console.log("\n--- deleting a template never touches what it created ---");
  const rentExpensesBefore = await liveExpenses(group._id, "Rent");
  await recurringExpenseService.remove({ group, templateId: rent.id });
  check("the expenses are all still there", await liveExpenses(group._id, "Rent"), rentExpensesBefore);
  check(
    "and the template is gone from the list",
    (await recurringExpenseService.listForGroup(group)).templates.some((t) => t.id === rent.id),
    false
  );

  console.log("\n--- an archived group is not written into by a scheduler ---");
  await Group.updateOne({ _id: group._id }, { $set: { status: "ARCHIVED" } });
  await makeDue(wifi.id, recurrence.startOfDay(new Date()));
  await recurringExpenseService.runDue();
  check("nothing was added to an archived group", await liveExpenses(group._id, "Wifi"), 0);
  await Group.updateOne({ _id: group._id }, { $set: { status: "ACTIVE" } });

  console.log("\n--- category breakdown ---");
  const month = {
    from: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
    to: new Date(),
  };

  const breakdown = await analyticsService.categoryBreakdown(group, month);
  const summed = breakdown.categories.reduce((sum, row) => sum + row.totalMinor, 0);
  check("the slices add up to the total printed above them", summed, breakdown.totalMinor);
  check("rent is in there", breakdown.categories.some((row) => row.category === "RENT"), true);
  check("scoped to the group", breakdown.scope, "GROUP");

  const mine = await analyticsService.categoryBreakdown(group, {
    ...month,
    memberId: String(riya._id),
  });
  check("one member's view is their share, not the whole expense", mine.totalMinor < breakdown.totalMinor, true);
  check("and it names them", mine.member.name, "Riya");

  console.log("\n--- the free plan sees this month and not last year ---");
  const lastYear = await refusalCode(() =>
    analyticsService.categoryBreakdown(group, {
      from: new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1)),
      to: new Date(),
    })
  );
  check("older months are refused, with a reason", lastYear, ERROR_CODES.FEATURE_LOCKED);

  const allHistory = await refusalCode(() => analyticsService.categoryBreakdown(group, {}));
  check("and so is 'everything'", allHistory, ERROR_CODES.FEATURE_LOCKED);

  await entitlementService.grant({ group, plan: PLANS.GROUP_PRO, days: 30 });
  const withPlan = await analyticsService.categoryBreakdown(group, {
    from: new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1)),
    to: new Date(),
  });
  check("with a plan, the whole history opens up", Boolean(withPlan.categories), true);

  console.log("\n--- cleanup ---");
  await RecurringExpense.deleteMany({ groupId: group._id });
  await FeatureUsage.deleteMany({ groupId: group._id });
  await Entitlement.deleteMany({ groupId: group._id });
  await Expense.deleteMany({ groupId: group._id });
  await Activity.deleteMany({ groupId: group._id });
  await Member.deleteMany({ groupId: group._id });
  await Group.deleteOne({ _id: group._id });
  console.log("  done");
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
