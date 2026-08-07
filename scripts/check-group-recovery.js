/**
 * Getting groups back after clearing browser storage, when signed in.
 *
 *   node scripts/check-group-recovery.js
 *
 * The assertion that matters: a browser shared by two accounts recovers nothing,
 * because "this device was mine" stops being evidence the moment it was also
 * somebody else's.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const memberService = require("../src/services/memberService");
const groupRecoveryService = require("../src/services/groupRecoveryService");
const User = require("../src/models/user");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Activity = require("../src/models/activity");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

(async () => {
  await connectDB();

  const stamp = Date.now();
  const oldDevice = `old-${stamp}`;
  const newDevice = `new-${stamp}`;
  const groups = [];
  const users = [];

  /** Riya, signed in, with two groups on her old browser. */
  const riya = await User.create({
    firebaseUid: `rec-riya-${stamp}`,
    email: "riya@example.com",
    deviceIds: [oldDevice],
  });
  users.push(riya._id);

  for (const name of ["Flat 12", "Goa trip"]) {
    const created = await groupService.createGroup({
      name,
      currency: "INR",
      creatorName: "Riya",
      deviceId: oldDevice,
    });
    const group = await Group.findById(
      created.group?.id || created.group?._id || created.id || created._id
    );
    groups.push(group);
  }

  console.log("--- she clears her browser and signs in again ---");
  // A new browser means a new device id; signing in adds it to her account.
  await User.updateOne({ _id: riya._id }, { $addToSet: { deviceIds: newDevice } });
  const signedIn = await User.findById(riya._id);

  const before = await Member.findOne({ groupId: groups[0]._id });
  check("her member row still holds only the dead device", before.deviceIds.includes(newDevice), false);

  console.log("\n--- the account can prove which groups were hers ---");
  const found = await groupRecoveryService.findRecoverable(signedIn, newDevice);
  console.log(`  found: ${found.map((g) => g.groupName).join(", ")}`);
  check("both groups are offered", found.length, 2);
  check("with the name she goes by", found[0].memberName, "Riya");

  console.log("\n--- finding is not doing ---");
  const untouched = await Member.findOne({ groupId: groups[0]._id });
  check("nothing changed by looking", untouched.deviceIds.includes(newDevice), false);

  console.log("\n--- restoring attaches the new browser ---");
  const result = await groupRecoveryService.restore(signedIn, newDevice);
  check("both restored", result.restored.length, 2);
  check("none skipped", result.skipped, 0);

  const after = await Member.findOne({ groupId: groups[0]._id });
  check("the new browser is hers", after.deviceIds.includes(newDevice), true);
  check("the old id is kept, not dropped", after.deviceIds.includes(oldDevice), true);
  check("same member row", String(after._id), String(before._id));
  check("still one member in the group", await Member.countDocuments({ groupId: groups[0]._id }), 1);

  console.log("\n--- and there is nothing left to offer ---");
  check("already recovered", (await groupRecoveryService.findRecoverable(signedIn, newDevice)).length, 0);

  console.log("\n--- THE SHARED LAPTOP: two accounts, one browser ---");
  const shared = `shared-${stamp}`;
  const flatA = await User.create({
    firebaseUid: `rec-a-${stamp}`,
    email: "a@example.com",
    deviceIds: [shared],
  });
  const flatB = await User.create({
    firebaseUid: `rec-b-${stamp}`,
    email: "b@example.com",
    deviceIds: [shared],
  });
  users.push(flatA._id, flatB._id);

  const sharedGroup = await groupService.createGroup({
    name: "Shared laptop group",
    currency: "INR",
    creatorName: "Whoever",
    deviceId: shared,
  });
  const sharedFull = await Group.findById(
    sharedGroup.group?.id || sharedGroup.group?._id || sharedGroup.id || sharedGroup._id
  );
  groups.push(sharedFull);

  const aDevice = `a-new-${stamp}`;
  await User.updateOne({ _id: flatA._id }, { $addToSet: { deviceIds: aDevice } });
  const aSignedIn = await User.findById(flatA._id);

  const ambiguous = await groupRecoveryService.findRecoverable(aSignedIn, aDevice);
  check("a shared browser proves nothing", ambiguous.length, 0);

  const nothingDone = await groupRecoveryService.restore(aSignedIn, aDevice);
  check("and restoring does nothing", nothingDone.restored.length, 0);
  const sharedMember = await Member.findOne({ groupId: sharedFull._id });
  check("the membership is untouched", sharedMember.deviceIds.includes(aDevice), false);

  console.log("\n--- restoring only what was asked for ---");
  const picky = `picky-${stamp}`;
  const pickyUser = await User.create({
    firebaseUid: `rec-p-${stamp}`,
    email: "p@example.com",
    deviceIds: [picky],
  });
  users.push(pickyUser._id);

  for (const name of ["Keep this", "Leave this"]) {
    const created = await groupService.createGroup({
      name,
      currency: "INR",
      creatorName: "Picky",
      deviceId: picky,
    });
    groups.push(
      await Group.findById(created.group?.id || created.group?._id || created.id || created._id)
    );
  }

  const pickyNew = `picky-new-${stamp}`;
  await User.updateOne({ _id: pickyUser._id }, { $addToSet: { deviceIds: pickyNew } });
  const pickySignedIn = await User.findById(pickyUser._id);

  const options = await groupRecoveryService.findRecoverable(pickySignedIn, pickyNew);
  const keep = options.find((row) => row.groupName === "Keep this");
  const partial = await groupRecoveryService.restore(pickySignedIn, pickyNew, [keep.memberId]);
  check("only the chosen one", partial.restored.length, 1);
  check("and it is the right one", partial.restored[0].groupName, "Keep this");
  check(
    "the other is still offered",
    (await groupRecoveryService.findRecoverable(pickySignedIn, pickyNew)).length,
    1
  );

  console.log("\n--- cleanup ---");
  const ids = groups.map((g) => g._id);
  await Activity.deleteMany({ groupId: { $in: ids } });
  await Member.deleteMany({ groupId: { $in: ids } });
  await Group.deleteMany({ _id: { $in: ids } });
  await User.deleteMany({ _id: { $in: users } });
  console.log("  done");
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
