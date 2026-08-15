/**
 * CSV export (docs/22-MONETIZATION.md §14 step 3).
 *
 *   node scripts/check-export.js          # assertions only
 *   node scripts/check-export.js --print  # …and print the file it produced
 *
 * The escaping is covered by tests/csvExport.test.js without a database. What is
 * checked here is the loop: that the allowance is spent once per file, that a
 * hostile description survives into a real export defanged, and that the numbers
 * in the file are the numbers in the group.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const expenseService = require("../src/services/expenseService");
const settlementService = require("../src/services/settlementService");
const exportService = require("../src/services/exportService");
const entitlementService = require("../src/services/entitlementService");
const config = require("../src/config/env");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Expense = require("../src/models/expense");
const Settlement = require("../src/models/settlement");
const Activity = require("../src/models/activity");
const Entitlement = require("../src/models/entitlement");
const FeatureUsage = require("../src/models/featureUsage");
const { FEATURES, ERROR_CODES, PLANS } = require("../src/constants");

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

const usedExports = async (groupId) => {
  const bucket = await FeatureUsage.findOne({
    groupId,
    feature: FEATURES.EXPORT,
    period: entitlementService.periodKey(),
  });
  return bucket?.used || 0;
};

/**
 * Put the meter back. The free allowance is two a month — deliberately small —
 * and this script exercises more cases than a free group has exports.
 */
const setExports = (groupId, used) =>
  FeatureUsage.updateOne(
    { groupId, feature: FEATURES.EXPORT, period: entitlementService.periodKey() },
    { $set: { used } },
    { upsert: true }
  );

/** The file as lines, with the BOM stripped so the first header is readable. */
const linesOf = (buffer) => buffer.toString("utf8").replace(/^﻿/, "").trim().split("\r\n");

(async () => {
  await connectDB();

  const stamp = Date.now();

  const created = await groupService.createGroup({
    name: "Flat 302",
    currency: "INR",
    creatorName: "Aman",
    deviceId: `export-${stamp}`,
  });

  const group = await Group.findById(created.group.id);
  const aman = await Member.findOne({ groupId: group._id });
  const riya = await Member.create({
    groupId: group._id,
    name: "Riya",
    deviceIds: [`riya-${stamp}`],
    isActive: true,
  });

  const both = [String(aman._id), String(riya._id)];

  await expenseService.createExpense({
    group,
    actor: aman,
    dto: { description: "Groceries", amount: 300, paidBy: String(aman._id), participantIds: both },
  });

  /** The attack the CSV guard exists for, typed by another member. */
  await expenseService.createExpense({
    group,
    actor: riya,
    dto: {
      description: '=HYPERLINK("https://evil.example.com","Click")',
      amount: 100,
      paidBy: String(riya._id),
      participantIds: [String(riya._id)],
    },
  });

  // A comma and a quote, which are the ordinary way to break a CSV.
  await expenseService.createExpense({
    group,
    actor: aman,
    dto: {
      description: 'Dinner, drinks and "the good chai"',
      amount: 250,
      paidBy: String(aman._id),
      participantIds: both,
    },
  });

  await settlementService.recordSettlement({
    group,
    actor: riya,
    dto: {
      fromMemberId: String(riya._id),
      toMemberId: String(aman._id),
      amount: 75,
      method: "MANUAL",
      note: "UPI",
    },
  });

  console.log("--- an export costs exactly one ---");
  const before = await usedExports(group._id);
  const file = await exportService.build({ group });
  check("one export used", await usedExports(group._id), before + 1);
  check("it says what is left", file.exportsLeft, config.entitlement.free.exports - 1);
  check("three expenses in the file", file.rowCount, 3);
  check("named after the group", file.filename, "Flat 302 expenses.csv");

  console.log("\n--- the file is readable by a spreadsheet ---");
  const lines = linesOf(file.body);
  check("a header plus a row each", lines.length, 4);
  check("the BOM is there for Excel", file.body[0], 0xef);
  check("a column per member", lines[0].includes("Aman (INR)") && lines[0].includes("Riya (INR)"), true);

  console.log("\n--- THE POINT: a formula cannot reach a spreadsheet armed ---");
  const hostile = lines.find((line) => line.includes("HYPERLINK"));
  check("the row is there", Boolean(hostile), true);
  check(
    "and it is quoted and prefixed, so it is text",
    hostile.includes("\"'=HYPERLINK"),
    true
  );

  console.log("\n--- commas and quotes survive ---");
  const tricky = lines.find((line) => line.includes("the good chai"));
  check("the row is intact", Boolean(tricky), true);
  check("inner quotes are doubled", tricky.includes('""the good chai""'), true);

  console.log("\n--- the numbers in the file are the numbers in the group ---");
  // Groceries: 300 split two ways is 150 each. The row must add up to itself.
  const groceries = lines.find((line) => line.startsWith("2") && line.includes("Groceries"));
  const cells = groceries.split(",");
  const amount = Number(cells[4]);
  const shares = Number(cells[5]) + Number(cells[6]);
  check("the shares total the amount", shares, amount);
  check("and the amount is what was spent", amount, 300);

  console.log("\n--- somebody outside a split gets an empty cell, not a zero ---");
  const riyaOnly = lines.find((line) => line.includes("HYPERLINK"));
  // Aman's column, on an expense only Riya was in.
  check("empty, not 0.00", riyaOnly.split(",").includes("0.00"), false);

  console.log("\n--- settlements export separately ---");
  const payments = await exportService.build({ group, type: "settlements" });
  check("one payment", payments.rowCount, 1);
  check("named for what it holds", payments.filename, "Flat 302 settlements.csv");
  check("from and to are named", linesOf(payments.body)[1].includes("Riya"), true);

  console.log("\n--- a date range narrows it, and says so in the name ---");
  await setExports(group._id, 0);
  const ranged = await exportService.build({
    group,
    from: new Date("2020-01-01"),
    to: new Date("2020-12-31"),
  });
  check("nothing in 2020", ranged.rowCount, 0);
  check("the range is in the filename", ranged.filename.includes("2020-01-01"), true);
  check("and a header row is still written", linesOf(ranged.body).length, 1);

  console.log("\n--- running out stops the export and nothing else ---");
  await setExports(group._id, config.entitlement.free.exports);

  const spent = await refusalCode(() => exportService.build({ group }));
  check("the wall appears", spent, ERROR_CODES.FEATURE_LIMIT_REACHED);

  // §8: the refusal has to name what still works, and for an export that is not
  // "add it by hand" — the wording is per-feature for exactly this reason.
  let refusalMessage = "";
  await exportService.build({ group }).catch((error) => {
    refusalMessage = error.message;
  });
  check("and it says what still works", /still here to read/i.test(refusalMessage), true);

  const summary = await groupService.getSummary(group, aman);
  check("the group still works", Boolean(summary.group), true);
  check("and it knows exports are spent", summary.entitlement.features.export, false);

  console.log("\n--- a plan brings it back ---");
  await entitlementService.grant({ group, plan: PLANS.GROUP_PRO, days: 30 });
  const withPlan = await exportService.build({ group });
  check("exporting again", withPlan.rowCount, 3);

  if (process.argv.includes("--print")) {
    console.log("\n--- the file ---");
    console.log(file.body.toString("utf8").replace(/^﻿/, ""));
  }

  console.log("\n--- cleanup ---");
  await FeatureUsage.deleteMany({ groupId: group._id });
  await Entitlement.deleteMany({ groupId: group._id });
  await Settlement.deleteMany({ groupId: group._id });
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
