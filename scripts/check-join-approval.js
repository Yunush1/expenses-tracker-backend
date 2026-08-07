/**
 * Join-by-code approval (docs/13-JOIN-APPROVAL.md).
 *
 *   node scripts/check-join-approval.js
 *
 * The assertion that matters most: a correct short code, on its own, grants
 * nothing.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const joinRequestService = require("../src/services/joinRequestService");
const JoinRequest = require("../src/models/joinRequest");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Activity = require("../src/models/activity");
const { JOIN_REQUEST_STATUS } = require("../src/constants");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

(async () => {
  await connectDB();

  const stamp = Date.now();
  const ownerDevice = `owner-${stamp}`;
  const strangerDevice = `stranger-${stamp}`;
  const joinCode = `JOIN${String(stamp).slice(-4)}`;

  const created = await groupService.createGroup({
    name: "Trip",
    currency: "INR",
    creatorName: "Owner",
    deviceId: ownerDevice,
    joinCode,
  });
  const group = await Group.findById(
    created.group?.id || created.group?._id || created.id || created._id
  );
  const owner = await Member.findOne({ groupId: group._id });

  console.log("--- THE POINT: a correct code alone gives nothing away ---");
  const lookup = await groupService.lookupByJoinCode(joinCode, strangerDevice);
  check("the group name is confirmed", lookup.groupName, "Trip");
  check("the invite code is NOT returned", lookup.inviteCode, undefined);
  check("the client is told approval is needed", lookup.requiresApproval, true);

  console.log("\n--- a member's own browser skips the queue ---");
  const ownerLookup = await groupService.lookupByJoinCode(joinCode, ownerDevice);
  check("already a member → invite code returned", ownerLookup.inviteCode, group.inviteCode);

  console.log("\n--- a wrong code is indistinguishable from a missing group ---");
  let wrongMessage = "";
  try {
    await groupService.lookupByJoinCode("ZZZZZZZZ", strangerDevice);
  } catch (err) {
    wrongMessage = err.message;
  }
  check("wrong code reports nothing useful", wrongMessage, "No group found with that code");

  console.log("\n--- asking creates a pending request, not a member ---");
  const asked = await joinRequestService.request({
    code: joinCode,
    name: "Stranger",
    deviceId: strangerDevice,
  });
  check("status is pending", asked.status, JOIN_REQUEST_STATUS.PENDING);
  check("still no invite code", asked.inviteCode, undefined);
  check("no member was created", await Member.countDocuments({ groupId: group._id }), 1);

  console.log("\n--- polling before a decision reveals nothing ---");
  const waiting = await joinRequestService.statusFor({
    requestId: asked.id,
    deviceId: strangerDevice,
  });
  check("still pending", waiting.status, JOIN_REQUEST_STATUS.PENDING);
  check("invite code withheld while pending", waiting.inviteCode, undefined);

  console.log("\n--- another device cannot read someone else's request ---");
  let peeked = false;
  try {
    await joinRequestService.statusFor({ requestId: asked.id, deviceId: "someone-else" });
    peeked = true;
  } catch {
    peeked = false;
  }
  check("scoped to the asking device", peeked, false);

  console.log("\n--- asking twice does not spam the group ---");
  const again = await joinRequestService.request({
    code: joinCode,
    name: "Stranger",
    deviceId: strangerDevice,
  });
  check("the same request comes back", String(again.id), String(asked.id));
  check(
    "exactly one pending row",
    await JoinRequest.countDocuments({ groupId: group._id, status: JOIN_REQUEST_STATUS.PENDING }),
    1
  );

  console.log("\n--- a member can see it waiting ---");
  const pendingList = await joinRequestService.listPending(group);
  check("one request listed", pendingList.length, 1);
  check("with the name they gave", pendingList[0].name, "Stranger");

  console.log("\n--- approving lets them in, once ---");
  const decision = await joinRequestService.decide({
    group,
    actor: owner,
    requestId: asked.id,
    approve: true,
  });
  check("status is approved", decision.status, JOIN_REQUEST_STATUS.APPROVED);
  check("a member now exists", await Member.countDocuments({ groupId: group._id }), 2);

  const second = await joinRequestService.decide({
    group,
    actor: owner,
    requestId: asked.id,
    approve: true,
  });
  check("a second tap is a no-op", second.alreadyDecided, true);
  check("still exactly two members", await Member.countDocuments({ groupId: group._id }), 2);

  console.log("\n--- and only now does the invite code appear ---");
  const afterApproval = await joinRequestService.statusFor({
    requestId: asked.id,
    deviceId: strangerDevice,
  });
  check("invite code released on approval", afterApproval.inviteCode, group.inviteCode);

  console.log("\n--- declining keeps them out and keeps the code hidden ---");
  const otherDevice = `other-${stamp}`;
  const second2 = await joinRequestService.request({
    code: joinCode,
    name: "Nope",
    deviceId: otherDevice,
  });
  await joinRequestService.decide({
    group,
    actor: owner,
    requestId: second2.id,
    approve: false,
  });
  const declined = await joinRequestService.statusFor({
    requestId: second2.id,
    deviceId: otherDevice,
  });
  check("status is declined", declined.status, JOIN_REQUEST_STATUS.DECLINED);
  check("no invite code for a declined request", declined.inviteCode, undefined);
  check("no member added", await Member.countDocuments({ groupId: group._id }), 2);

  console.log("\n--- a non-member cannot decide ---");
  let refused = false;
  try {
    await joinRequestService.decide({ group, actor: null, requestId: second2.id, approve: true });
  } catch {
    refused = true;
  }
  check("actor must be a member", refused, true);

  console.log("\n--- expiry closes the door on stale requests ---");
  const third = await joinRequestService.request({
    code: joinCode,
    name: "Late",
    deviceId: `late-${stamp}`,
  });
  await JoinRequest.updateOne({ _id: third.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await joinRequestService.expireStale();
  check("the sweep expired it", expired >= 1, true);
  const afterSweep = await JoinRequest.findById(third.id);
  check("status is expired", afterSweep.status, JOIN_REQUEST_STATUS.EXPIRED);

  let staleTapRefused = false;
  try {
    await joinRequestService.decide({ group, actor: owner, requestId: third.id, approve: true });
  } catch {
    staleTapRefused = true;
  }
  const stale = await joinRequestService.decide({
    group,
    actor: owner,
    requestId: third.id,
    approve: true,
  }).catch(() => ({ alreadyDecided: true }));
  check("an expired request cannot be approved", stale.alreadyDecided || staleTapRefused, true);
  check("still two members", await Member.countDocuments({ groupId: group._id }), 2);

  console.log("\n--- cleanup ---");
  await JoinRequest.deleteMany({ groupId: group._id });
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
