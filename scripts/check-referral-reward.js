/**
 * Referrals paid in plan days (docs/22-MONETIZATION.md §11).
 *
 *   node scripts/check-referral-reward.js
 *
 * The points half is already covered by docs/12-REFERRALS.md and its own guards.
 * What is checked here is the new half, and above all the guard §11 names:
 *
 *   "The reward must attach to a group with real activity, or the farm is
 *    obvious: create a group, invite yourself, collect."
 *
 * So the assertions that matter are the refusals — a solo group earns nothing, an
 * empty group earns nothing — and the once-only-ness of the grant.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const expenseService = require("../src/services/expenseService");
const referralRewardService = require("../src/services/referralRewardService");
const entitlementService = require("../src/services/entitlementService");
const config = require("../src/config/env");
const User = require("../src/models/user");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Expense = require("../src/models/expense");
const Activity = require("../src/models/activity");
const Entitlement = require("../src/models/entitlement");
const { PLANS, GRANT_SOURCES } = require("../src/constants");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

/** A group with `payers` distinct people having each paid for something. */
const buildGroup = async ({ name, deviceId, payers }) => {
  const created = await groupService.createGroup({
    name,
    currency: "INR",
    creatorName: "Owner",
    deviceId,
  });

  const group = await Group.findById(created.group.id);
  const owner = await Member.findOne({ groupId: group._id });
  const members = [owner];

  for (let i = 1; i < payers; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    members.push(
      await Member.create({
        groupId: group._id,
        name: `Member ${i}`,
        deviceIds: [`${deviceId}-m${i}`],
        isActive: true,
      })
    );
  }

  for (const member of members.slice(0, payers)) {
    // eslint-disable-next-line no-await-in-loop
    await expenseService.createExpense({
      group,
      actor: member,
      dto: {
        description: "Groceries",
        amount: 100,
        paidBy: String(member._id),
        participantIds: [String(member._id)],
      },
    });
  }

  return { group, owner, members };
};

(async () => {
  await connectDB();

  const stamp = Date.now();
  const deviceId = `ref-${stamp}`;
  const cleanup = [];

  console.log(`--- configured payout: ${config.entitlement.referralGrantDays} days ---`);
  check("the payout is switched on", referralRewardService.daysPerReferral() > 0, true);

  /**
   * The referrer, as the referral flow will hand them over — a user row whose
   * devices are what bind them to groups. There is no user→group edge in this
   * schema, which is the no-account design working rather than a missing index.
   */
  const referrer = await User.create({
    firebaseUid: `uid-${stamp}`,
    email: `ref-${stamp}@example.com`,
    deviceIds: [deviceId],
  });

  console.log("\n--- THE GUARD: a group one person uses alone earns nothing ---");
  const solo = await buildGroup({ name: "Solo", deviceId, payers: 1 });
  cleanup.push(solo.group);

  const noReward = await referralRewardService.grantForReferral(referrer);
  check("no plan days for a one-payer group", noReward, null);
  check(
    "and no entitlement row was created",
    await Entitlement.countDocuments({ groupId: solo.group._id }),
    0
  );

  console.log("\n--- two people actually using it is what qualifies ---");
  const shared = await buildGroup({ name: "Flat 302", deviceId: `${deviceId}-b`, payers: 2 });
  cleanup.push(shared.group);

  // The referrer has to be a member of it, on one of their own devices.
  await Member.updateOne(
    { _id: shared.owner._id },
    { $addToSet: { deviceIds: deviceId } }
  );

  const rewarded = await referralRewardService.grantForReferral(referrer, {
    referredUserId: "someone",
  });

  check("a group was rewarded", Boolean(rewarded), true);
  check("the activated one", rewarded?.groupName, "Flat 302");
  check("with the configured days", rewarded?.days, config.entitlement.referralGrantDays);

  const entitlement = await entitlementService.forGroup(shared.group._id);
  check("the group is on Group Pro", entitlement.plan, PLANS.GROUP_PRO);
  check("attributed to the referral", entitlement.row.source, GRANT_SOURCES.REFERRAL);
  check("and it says who it was for", entitlement.row.note.includes("someone"), true);

  console.log("\n--- a second referral extends rather than replaces ---");
  const before = entitlement.expiresAt;
  await referralRewardService.grantForReferral(referrer);
  const after = (await entitlementService.forGroup(shared.group._id)).expiresAt;
  const addedDays = Math.round((after - before) / (24 * 60 * 60 * 1000));
  check("days were added on top", addedDays, config.entitlement.referralGrantDays);

  console.log("\n--- the most recently active qualifying group wins ---");
  const older = await buildGroup({ name: "Old trip", deviceId: `${deviceId}-c`, payers: 2 });
  cleanup.push(older.group);
  await Member.updateOne({ _id: older.owner._id }, { $addToSet: { deviceIds: deviceId } });

  // Make the older group genuinely older, and the flat the freshest.
  await Group.updateOne(
    { _id: older.group._id },
    { $set: { lastActivityAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } }
  );
  await Group.updateOne({ _id: shared.group._id }, { $set: { lastActivityAt: new Date() } });

  const picked = await referralRewardService.rewardableGroup(referrer);
  check("the group being lived in", picked?.name, "Flat 302");

  console.log("\n--- an archived group is never rewarded ---");
  await Group.updateOne({ _id: shared.group._id }, { $set: { status: "ARCHIVED" } });
  const archivedPick = await referralRewardService.rewardableGroup(referrer);
  check("it falls through to the older active one", archivedPick?.name, "Old trip");
  await Group.updateOne({ _id: shared.group._id }, { $set: { status: "ACTIVE" } });

  console.log("\n--- somebody in no groups at all earns nothing, quietly ---");
  const stranger = await User.create({
    firebaseUid: `uid-none-${stamp}`,
    email: `none-${stamp}@example.com`,
    deviceIds: [`nobody-${stamp}`],
  });
  check("no crash, no grant", await referralRewardService.grantForReferral(stranger), null);

  /**
   * The `ENTITLEMENT_REFERRAL_DAYS=0` off switch is deliberately not asserted
   * here. `config` is frozen at require time, so a truthful test of it means
   * reloading the module registry under a different environment — which is what
   * tests/entitlement.test.js is set up to do, and where that case lives.
   */

  console.log("\n--- cleanup ---");
  for (const group of cleanup) {
    await Entitlement.deleteMany({ groupId: group._id });
    await Expense.deleteMany({ groupId: group._id });
    await Activity.deleteMany({ groupId: group._id });
    await Member.deleteMany({ groupId: group._id });
    await Group.deleteOne({ _id: group._id });
  }
  await User.deleteMany({ _id: { $in: [referrer._id, stranger._id] } });
  console.log("  done");
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
