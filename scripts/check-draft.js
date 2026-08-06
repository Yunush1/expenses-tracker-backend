/**
 * Ria's expense drafting: intent detection, extraction, and the boundary that
 * says a model never writes money (docs/10-AI-ASSISTANT.md §7).
 *
 *   node scripts/check-draft.js
 *
 * The intent and parsing checks are offline. The extraction check calls the
 * configured provider and is skipped when there is no API key.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const expenseDraft = require("../src/services/ai/expenseDraft");
const aiProvider = require("../src/services/ai/aiProvider");
const groupService = require("../src/services/groupService");
const memberService = require("../src/services/memberService");
const User = require("../src/models/user");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Activity = require("../src/models/activity");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

(async () => {
  console.log("--- intent: what counts as 'add this' ---");
  const adds = [
    "add 1200 for dinner",
    "log 450 groceries split with everyone",
    "record 90 for auto",
    "put 2000 for the hotel",
  ];
  const notAdds = [
    "what did I spend this month?",
    "how much did I add last week",
    "who owes me the most?",
    "add",
    "add an expense",
    "show me my expenses",
    "did I add the taxi?",
  ];

  for (const text of adds) check(`"${text}"`, expenseDraft.looksLikeAdd(text), true);
  for (const text of notAdds) check(`"${text}" is not an add`, expenseDraft.looksLikeAdd(text), false);

  console.log("\n--- JSON parsing survives what models actually return ---");
  check(
    "plain object",
    expenseDraft.parseJson('{"isExpense":true,"amount":"12"}')?.amount,
    "12"
  );
  check(
    "wrapped in a markdown fence",
    expenseDraft.parseJson('```json\n{"isExpense":true,"amount":"12"}\n```')?.amount,
    "12"
  );
  check(
    "with chatter around it",
    expenseDraft.parseJson('Sure! {"isExpense":true,"amount":"12"} Hope that helps.')?.amount,
    "12"
  );
  check("garbage returns null", expenseDraft.parseJson("no json here"), null);

  console.log("\n--- member matching is forgiving about case and spacing ---");
  const roster = [
    { _id: "1", name: "Riya" },
    { _id: "2", name: "Sam Kapoor" },
  ];
  check("exact", expenseDraft.findMember(roster, "Riya")?.name, "Riya");
  check("lowercase", expenseDraft.findMember(roster, "riya")?.name, "Riya");
  check("first name only", expenseDraft.findMember(roster, "sam")?.name, "Sam Kapoor");
  check("unknown person", expenseDraft.findMember(roster, "Nobody"), null);

  if (!aiProvider.isConfigured()) {
    console.log("\n(no AI provider configured — skipping the extraction check)\n");
    return;
  }

  await connectDB();
  const stamp = Date.now();
  const device = `draft-device-${stamp}`;
  const user = await User.create({
    firebaseUid: `draft-${stamp}`,
    email: "draft@example.com",
    deviceIds: [device],
  });

  const created = await groupService.createGroup({
    name: "Flat 12",
    currency: "INR",
    creatorName: "Me",
    deviceId: device,
  });
  const full = await Group.findById(
    created.group?.id || created.group?._id || created.id || created._id
  );
  const first = await Member.find({ groupId: full._id }).lean();
  const me = first[0];
  for (const name of ["Riya", "Sam"]) {
    await memberService.addMember({ group: full, actor: me, name });
  }

  console.log("--- extraction, against the real provider ---");
  const draft = await expenseDraft.draftExpense(user, "add 1200 for dinner split with everyone");

  if (!draft) {
    console.log("  FAIL  no draft returned");
  } else {
    console.log(`  model returned: ${draft.amount} · "${draft.description}" · ${draft.groupName}`);
    check("amount extracted exactly", draft.amount, "1200");
    check("a group was chosen", draft.groupName, "Flat 12");
    check("everyone is included", draft.participants.length, 3);
    check("defaults the payer to the speaker", draft.paidBy.name, me.name);
    check("split type", draft.splitType, "EQUAL");
    check("it is a proposal, not a write", draft.needsGroup, false);
  }

  console.log("\n--- a question does not produce a draft ---");
  const notDraft = await expenseDraft.draftExpense(user, "what did I spend this month?");
  check("questions are answered, not drafted", notDraft, null);

  console.log("\n--- nothing was written ---");
  const Expense = require("../src/models/expense");
  check("no expense created by drafting", await Expense.countDocuments({ groupId: full._id }), 0);

  console.log("\n--- cleanup ---");
  await Activity.deleteMany({ groupId: full._id });
  await Member.deleteMany({ groupId: full._id });
  await Group.deleteOne({ _id: full._id });
  await User.deleteOne({ _id: user._id });
  console.log("  done");
})()
  .then(async () => {
    await mongoose.disconnect().catch(() => {});
  })
  .catch(async (e) => {
    console.error("FAILED:", e.stack || e.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
