/**
 * Expense search, filters, date-field choice and sorting.
 *
 *   node scripts/check-expense-filters.js
 *
 * The one that matters most: paging a sorted list must not lose rows.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const memberService = require("../src/services/memberService");
const expenseService = require("../src/services/expenseService");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Expense = require("../src/models/expense");
const Activity = require("../src/models/activity");
const { inferCategory } = require("../src/utils/inferCategory");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

const day = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);

(async () => {
  await connectDB();

  const stamp = Date.now();
  const device = `filters-${stamp}`;
  const created = await groupService.createGroup({
    name: "Filters",
    currency: "INR",
    creatorName: "Me",
    deviceId: device,
  });
  const group = await Group.findById(
    created.group?.id || created.group?._id || created.id || created._id
  );
  const first = await Member.find({ groupId: group._id }).lean();
  const me = first[0];
  await memberService.addMember({ group, actor: me, name: "Riya" });
  const members = await Member.find({ groupId: group._id }).lean();
  const ids = members.map((m) => String(m._id));

  const rows = [
    { description: "Dinner at the dhaba", amount: "1200", days: 1 },
    { description: "Auto to station", amount: "90", days: 2 },
    { description: "Movie tickets", amount: "600", days: 3 },
    { description: "Groceries run", amount: "450", days: 4 },
    { description: "Electricity bill", amount: "2300", days: 5 },
    { description: "Dinner again", amount: "800", days: 6 },
    { description: "Shampoo and soap", amount: "300", days: 7 },
  ];

  for (const row of rows) {
    await expenseService.createExpense({
      group,
      actor: me,
      dto: {
        description: row.description,
        amount: row.amount,
        paidBy: String(me._id),
        participantIds: ids,
        splitType: "EQUAL",
        expenseDate: day(row.days),
      },
    });
  }

  console.log("--- categories are stored, so they can be filtered on ---");
  const dinner = await Expense.findOne({ groupId: group._id, description: /dhaba/ }).lean();
  check("'Dinner at the dhaba' → FOOD", dinner.category, "FOOD");
  check("inference agrees", inferCategory("Dinner at the dhaba"), "FOOD");

  const food = await expenseService.listExpenses(group, { category: "FOOD" });
  console.log(`  FOOD: ${food.items.map((e) => e.description).join(", ")}`);
  check("three food rows", food.items.length, 3);

  const bills = await expenseService.listExpenses(group, { category: "BILLS" });
  check("one bill", bills.items.length, 1);
  const care = await expenseService.listExpenses(group, { category: "PERSONAL_CARE" });
  check("shampoo is personal care", care.items.length, 1);

  console.log("\n--- search matches a substring, not a whole word ---");
  const grocer = await expenseService.listExpenses(group, { q: "grocer" });
  check("'grocer' finds 'Groceries run'", grocer.items.length, 1);
  const dinnerSearch = await expenseService.listExpenses(group, { q: "dinner" });
  check("'dinner' is case-insensitive and finds both", dinnerSearch.items.length, 2);
  const nothing = await expenseService.listExpenses(group, { q: "helicopter" });
  check("no match returns nothing, not everything", nothing.items.length, 0);

  console.log("\n--- a regex in the search box is a literal, not a pattern ---");
  const literal = await expenseService.listExpenses(group, { q: ".*" });
  check("'.*' matches nothing", literal.items.length, 0);

  console.log("\n--- date range covers whole days, not instants ---");
  const recent = await expenseService.listExpenses(group, { from: day(3), to: day(0) });
  console.log(`  ${recent.items.map((e) => e.description).join(", ")}`);
  check("the day picked as 'from' is included", recent.items.length, 3);

  // The boundary case the day-rounding exists for: a range whose ends are the
  // same day as rows logged at a different time of day.
  const oneDay = await expenseService.listExpenses(group, { from: day(2), to: day(2) });
  check("a single-day range finds that day's row", oneDay.items.length, 1);
  check("and it is the right one", oneDay.items[0].description, "Auto to station");

  console.log("\n--- ...and the same range on the added date behaves differently ---");
  const byCreated = await expenseService.listExpenses(group, {
    dateField: "createdAt",
    from: day(3),
    to: new Date(Date.now() + 60_000),
  });
  console.log(`  all ${rows.length} were added just now, so createdAt catches them all`);
  check("every row was added today", byCreated.items.length, rows.length);

  console.log("\n--- sorting ---");
  const amountDesc = await expenseService.listExpenses(group, { sort: "amount_desc" });
  check("highest first", amountDesc.items[0].description, "Electricity bill");
  const amountAsc = await expenseService.listExpenses(group, { sort: "amount_asc" });
  check("lowest first", amountAsc.items[0].description, "Auto to station");
  const dateAsc = await expenseService.listExpenses(group, { sort: "date_asc" });
  check("oldest first", dateAsc.items[0].description, "Shampoo and soap");
  const dateDesc = await expenseService.listExpenses(group, { sort: "date_desc" });
  check("newest first", dateDesc.items[0].description, "Dinner at the dhaba");

  console.log("\n--- THE ONE THAT MATTERS: paging a sorted list loses nothing ---");
  for (const sort of ["date_desc", "date_asc", "amount_desc", "amount_asc"]) {
    const seen = [];
    let cursor;
    let guard = 0;

    do {
      // eslint-disable-next-line no-await-in-loop -- walking pages on purpose
      const page = await expenseService.listExpenses(group, { sort, limit: 2, cursor });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    const unique = new Set(seen);
    check(`${sort}: every row, exactly once`, `${seen.length}/${unique.size}`, `${rows.length}/${rows.length}`);
  }

  console.log("\n--- filters combine ---");
  const combined = await expenseService.listExpenses(group, {
    q: "dinner",
    category: "FOOD",
    sort: "amount_desc",
  });
  check("search + category + sort", combined.items.length, 2);
  check("and the sort still applies", combined.items[0].description, "Dinner at the dhaba");

  console.log("\n--- an unfiltered list is unchanged ---");
  const plain = await expenseService.listExpenses(group, {});
  check("everything, newest first", plain.items.length, rows.length);
  check("default sort is by expense date", plain.items[0].description, "Dinner at the dhaba");

  console.log("\n--- cleanup ---");
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
