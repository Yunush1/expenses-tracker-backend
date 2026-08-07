/**
 * Changing what a ledger entry is (docs/08-PERSONAL-LEDGER.md §13).
 *
 *   node scripts/check-ledger-type-change.js
 *
 * The rule that matters: a type change must never silently discard a record of
 * money that changed hands.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const ledgerService = require("../src/services/ledgerService");
const User = require("../src/models/user");
const Ledger = require("../src/models/ledger");
const LedgerEntry = require("../src/models/ledgerEntry");
const PointEvent = require("../src/models/pointEvent");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

const refuses = async (fn, code) => {
  try {
    await fn();
    return false;
  } catch (err) {
    return code ? err.code === code : true;
  }
};

(async () => {
  await connectDB();

  const stamp = Date.now();
  const user = await User.create({ firebaseUid: `type-${stamp}`, email: "t@example.com" });

  const make = (dto) => ledgerService.createEntry(user._id, dto);
  const edit = (id, dto) => ledgerService.updateEntry(user._id, id, dto);

  console.log("--- LENT ↔ BORROWED is free, and keeps the repayments ---");
  const lent = await make({
    type: "LENT",
    amount: "1000",
    description: "Cash",
    counterpartyName: "Rahul",
  });
  await ledgerService.addRepayment(user._id, lent.id, { amount: "400" });

  const flipped = await edit(lent.id, { type: "BORROWED", version: 1 });
  check("type changed", flipped.type, "BORROWED");
  check("repayment survived", flipped.repayments.length, 1);
  check("outstanding still derived", flipped.outstandingMinor, 60000);
  check("counterparty kept", flipped.counterpartyName, "Rahul");

  console.log("\n--- becoming a SPEND is refused while repayments exist ---");
  const blocked = await refuses(() => edit(lent.id, { type: "SPEND", version: 2 }));
  check("refused", blocked, true);
  const untouched = await LedgerEntry.findById(lent.id);
  check("nothing was changed", untouched.type, "BORROWED");
  check("the repayment is still there", untouched.repayments.length, 1);

  console.log("\n--- ...and allowed once they are gone ---");
  const repaymentId = String(untouched.repayments[0]._id);
  await ledgerService.removeRepayment(user._id, lent.id, repaymentId);
  const fresh = await LedgerEntry.findById(lent.id);
  const spent = await edit(lent.id, { type: "SPEND", version: fresh.version });
  check("now a spend", spent.type, "SPEND");
  check("counterparty cleared", spent.counterpartyName, "");
  check("due date cleared", spent.dueAt, null);
  check("settled cleared", spent.settledAt, null);

  console.log("\n--- a cleared due date stops the reminder sweep finding it ---");
  const afterSpend = await LedgerEntry.findById(lent.id);
  check("reminder count reset", afterSpend.reminderCount, 0);
  check("last reminded cleared", afterSpend.lastRemindedOn, "");

  console.log("\n--- SPEND → debt needs somebody to owe ---");
  const solo = await make({ type: "SPEND", amount: "250", description: "Petrol" });
  const noName = await refuses(() => edit(solo.id, { type: "LENT", version: 0 }));
  check("refused without a counterparty", noName, true);

  const named = await edit(solo.id, {
    type: "LENT",
    counterpartyName: "Sam",
    version: 0,
  });
  check("accepted with one", named.type, "LENT");
  check("counterparty set", named.counterpartyName, "Sam");
  check("a new debt is unsettled", named.settledAt, null);
  check("and fully outstanding", named.outstandingMinor, 25000);

  console.log("\n--- a mirrored group expense still refuses every edit ---");
  const ledger = await Ledger.findOne({ userId: user._id });
  const mirror = await LedgerEntry.create({
    ledgerId: ledger._id,
    type: "SPEND",
    amountMinor: 5000,
    description: "Dinner",
    source: "GROUP_EXPENSE",
    sourceGroupName: "Goa trip",
    version: 0,
  });
  const mirrorBlocked = await refuses(
    () => edit(String(mirror._id), { type: "LENT", counterpartyName: "X", version: 0 }),
    "LEDGER_ENTRY_NOT_EDITABLE"
  );
  check("refused with the right code", mirrorBlocked, true);

  console.log("\n--- a stale version is still rejected ---");
  const stale = await refuses(() => edit(solo.id, { type: "SPEND", version: 0 }));
  check("version conflict still enforced", stale, true);

  console.log("\n--- cleanup ---");
  await LedgerEntry.deleteMany({ ledgerId: ledger._id });
  await Ledger.deleteOne({ _id: ledger._id });
  await PointEvent.deleteMany({ userId: user._id });
  await User.deleteOne({ _id: user._id });
  console.log("  done");
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
