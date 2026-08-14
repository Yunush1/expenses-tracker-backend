/**
 * Group-scoped entitlement (docs/22-MONETIZATION.md).
 *
 *   node scripts/check-entitlement.js
 *
 * Runs the whole loop against a real database, because most of what matters here
 * is not arithmetic — that is covered in tests/entitlement.test.js — but the
 * things only a database can get wrong: whether a metered allowance survives being
 * spent concurrently, whether a grant reaches every member without any of them
 * signing in, and whether a group that loses its plan still has its money.
 *
 * The assertions that matter most, in order:
 *
 *   1. A downgrade takes features, never the ledger.
 *   2. Two simultaneous uses of the last receipt scan cannot both succeed.
 *   3. The entitlement follows the group, not the device that paid.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const expenseService = require("../src/services/expenseService");
const entitlementService = require("../src/services/entitlementService");
const entitlementRepository = require("../src/repositories/entitlementRepository");
const config = require("../src/config/env");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Expense = require("../src/models/expense");
const Activity = require("../src/models/activity");
const Entitlement = require("../src/models/entitlement");
const FeatureUsage = require("../src/models/featureUsage");
const { PLANS, PLAN_STATUS, FEATURES, ERROR_CODES } = require("../src/constants");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

/** Runs something that should be refused and reports the code it was refused with. */
const refusalCode = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code || "THREW";
  }
};

(async () => {
  await connectDB();

  const stamp = Date.now();
  const payerDevice = `payer-${stamp}`;
  const flatmateDevice = `flatmate-${stamp}`;

  const created = await groupService.createGroup({
    name: "Flat 302",
    currency: "INR",
    creatorName: "Aman",
    deviceId: payerDevice,
  });

  const group = await Group.findById(created.group.id);
  const payer = await Member.findOne({ groupId: group._id });

  console.log("--- a brand new group is FREE, and FREE is a real plan ---");
  let snapshot = await entitlementService.forGroup(group._id);
  check("plan is FREE", snapshot.plan, PLANS.FREE);
  check("status says so too", snapshot.status, PLAN_STATUS.FREE);
  check("nothing to expire", snapshot.expiresAt, null);
  check("no row was created to say nothing", await Entitlement.countDocuments({ groupId: group._id }), 0);
  check(
    "and it has a real free allowance",
    snapshot.limits.receiptScansLeft,
    config.entitlement.free.receiptScans
  );
  check("ads are on for a free group", snapshot.features.ads, true);

  console.log("\n--- limits before locks: the free allowance is usable ---");
  const freeScans = config.entitlement.free.receiptScans;
  check("a free group may scan", snapshot.features[FEATURES.RECEIPT_SCAN], freeScans > 0);

  for (let i = 0; i < freeScans; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- spending an allowance is sequential by nature
    const after = await entitlementService.consume(group, FEATURES.RECEIPT_SCAN);
    console.log(`     used ${i + 1}/${freeScans}, ${after.remaining} left`);
  }

  const exhausted = await refusalCode(() =>
    entitlementService.consume(group, FEATURES.RECEIPT_SCAN)
  );
  check("the allowance runs out", exhausted, ERROR_CODES.FEATURE_LIMIT_REACHED);

  snapshot = await entitlementService.forGroup(group._id);
  check("and the flag agrees with the counter", snapshot.features[FEATURES.RECEIPT_SCAN], false);
  check("nothing left", snapshot.limits.receiptScansLeft, 0);

  console.log("\n--- THE POINT: the wall is around the shortcut, never the ledger ---");
  const expense = await expenseService.createExpense({
    group,
    actor: payer,
    dto: {
      description: "Groceries",
      amount: 1200,
      paidBy: String(payer._id),
      participantIds: [String(payer._id)],
    },
  });
  check("an expense can still be added by hand", Boolean(expense.expense.id), true);

  console.log("\n--- a grant covers the whole group, and only the payer signed in ---");
  await entitlementService.grant({
    group,
    plan: PLANS.GROUP_PRO,
    days: 30,
    note: "check-entitlement.js",
    grantedByEmail: "operator@example.com",
  });

  snapshot = await entitlementService.forGroup(group._id);
  check("plan is Group Pro", snapshot.plan, PLANS.GROUP_PRO);
  check("scanning is back", snapshot.features[FEATURES.RECEIPT_SCAN], true);
  check(
    "with the paid allowance, less what was already used",
    snapshot.limits.receiptScansLeft,
    config.entitlement.paid.receiptScans - freeScans
  );
  check("ads are off for everyone in the group", snapshot.features.ads, false);

  /**
   * The whole reason entitlement is group-scoped: a second member, on a different
   * browser, who has never signed in and never paid, reads exactly the same plan.
   */
  const flatmate = await Member.create({
    groupId: group._id,
    name: "Riya",
    deviceIds: [flatmateDevice],
    isCreator: false,
    isActive: true,
  });
  const asFlatmate = await groupService.getSummary(group, flatmate);
  check("a member who never signed in sees the plan", asFlatmate.entitlement.plan, PLANS.GROUP_PRO);
  check("and can use it", asFlatmate.entitlement.features[FEATURES.RECEIPT_SCAN], true);
  check("no price is quoted to anyone", "price" in asFlatmate.entitlement, false);

  console.log("\n--- a second grant extends what is left rather than replacing it ---");
  const before = (await Entitlement.findOne({ groupId: group._id })).expiresAt;
  await entitlementService.grant({ group, plan: PLANS.GROUP_PRO, days: 30 });
  const after = (await Entitlement.findOne({ groupId: group._id })).expiresAt;
  const addedDays = Math.round((after - before) / (24 * 60 * 60 * 1000));
  check("30 more days were added on top", addedDays, 30);

  console.log("\n--- the last scan cannot be spent twice, however concurrent ---");
  await FeatureUsage.updateOne(
    { groupId: group._id, feature: FEATURES.RECEIPT_SCAN, period: entitlementService.periodKey() },
    { $set: { used: config.entitlement.paid.receiptScans - 1 } },
    { upsert: true }
  );

  const race = await Promise.allSettled([
    entitlementService.consume(group, FEATURES.RECEIPT_SCAN),
    entitlementService.consume(group, FEATURES.RECEIPT_SCAN),
  ]);
  const won = race.filter((r) => r.status === "fulfilled").length;
  check("exactly one of two simultaneous claims wins", won, 1);

  const bucket = await FeatureUsage.findOne({
    groupId: group._id,
    feature: FEATURES.RECEIPT_SCAN,
    period: entitlementService.periodKey(),
  });
  check("the meter never exceeds the allowance", bucket.used, config.entitlement.paid.receiptScans);

  console.log("\n--- a refund hands a claimed use back ---");
  await entitlementService.refund(group, FEATURES.RECEIPT_SCAN);
  const refunded = await FeatureUsage.findOne({
    groupId: group._id,
    feature: FEATURES.RECEIPT_SCAN,
    period: entitlementService.periodKey(),
  });
  check("one back on the meter", refunded.used, config.entitlement.paid.receiptScans - 1);

  console.log("\n--- an expired plan degrades to FREE with no sweep job ---");
  await entitlementRepository.upsert(group._id, { expiresAt: new Date(Date.now() - 1000) });
  snapshot = await entitlementService.forGroup(group._id);
  check("plan reads FREE", snapshot.plan, PLANS.FREE);
  check("status says it ended rather than never existed", snapshot.status, PLAN_STATUS.EXPIRED);
  check("the row is still there for billing questions", Boolean(snapshot.row), true);
  check(
    "and the row still says what was granted",
    (await Entitlement.findOne({ groupId: group._id })).plan,
    PLANS.GROUP_PRO
  );

  console.log("\n--- THE HARD RULE: downgrading never deletes anything ---");
  const stillThere = await Expense.countDocuments({ groupId: group._id, isDeleted: { $ne: true } });
  check("every expense survived the downgrade", stillThere >= 1, true);

  const afterDowngrade = await expenseService.createExpense({
    group,
    actor: payer,
    dto: {
      description: "Milk",
      amount: 60,
      paidBy: String(payer._id),
      participantIds: [String(payer._id)],
    },
  });
  check("and a new one can still be added", Boolean(afterDowngrade.expense.id), true);

  const balances = await groupService.getSummary(group, payer);
  check("balances still compute", Boolean(balances.myBalance), true);

  console.log("\n--- revoking is an expiry, not a delete ---");
  await entitlementService.grant({ group, plan: PLANS.TRIP_PASS, days: 11 });
  check("a trip pass is granted", (await entitlementService.forGroup(group._id)).plan, PLANS.TRIP_PASS);
  await entitlementService.revoke(group, { note: "ended by check script" });
  check("it is gone", (await entitlementService.forGroup(group._id)).plan, PLANS.FREE);
  check("but the record is not", await Entitlement.countDocuments({ groupId: group._id }), 1);

  console.log("\n--- FREE cannot be granted ---");
  const bogus = await refusalCode(() => entitlementService.grant({ group, plan: PLANS.FREE }));
  check("refused", bogus, ERROR_CODES.INVALID_PLAN);

  const tooLong = await refusalCode(() =>
    entitlementService.grant({ group, days: config.entitlement.maxGrantDays + 1 })
  );
  check("and so is a grant longer than the configured maximum", tooLong, ERROR_CODES.INVALID_PLAN);

  console.log("\n--- cleanup ---");
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
