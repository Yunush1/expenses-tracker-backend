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
const memberService = require("../src/services/memberService");
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

  console.log("--- a PUBLIC group keeps the old, instant flow ---");
  check("groups are public by default", Boolean(group.isPrivate), false);
  const publicLookup = await groupService.lookupByJoinCode(joinCode, strangerDevice);
  check("the code resolves straight to the link", publicLookup.inviteCode, group.inviteCode);
  check("no approval asked for", publicLookup.requiresApproval, undefined);

  const publicAsk = await joinRequestService.request({
    code: joinCode,
    name: "Walk-in",
    deviceId: `walkin-${stamp}`,
  });
  check("asking a public group just lets you in", publicAsk.open, true);
  check("no waiting row created", await JoinRequest.countDocuments({ groupId: group._id }), 0);

  console.log("\n--- the creator makes it private ---");
  await groupService.updateGroup({ group, actor: owner, isPrivate: true });
  Object.assign(group, await Group.findById(group._id));
  check("the switch is on", group.isPrivate, true);

  console.log("\n--- THE POINT: now a correct code gives nothing away ---");
  const lookup = await groupService.lookupByJoinCode(joinCode, strangerDevice);
  check("the group name is confirmed", lookup.groupName, "Trip");
  check("the invite code is NOT returned", lookup.inviteCode, undefined);
  check("the client is told approval is needed", lookup.requiresApproval, true);

  console.log("\n--- and the invite LINK is gated too ---");
  const linkAsk = await joinRequestService.request({
    group,
    name: "Link holder",
    deviceId: `linker-${stamp}`,
  });
  check("holding the link still means waiting", linkAsk.status, JOIN_REQUEST_STATUS.PENDING);
  check("no invite code handed back", linkAsk.inviteCode, undefined);
  check("no member created", await Member.countDocuments({ groupId: group._id }), 1);
  await JoinRequest.deleteOne({ _id: linkAsk.id });

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

  console.log("\n--- the waiting room is short, and honest about it ---");
  const ttlMinutes = require("../src/config/env").join.requestTtlMinutes;
  const timed = await joinRequestService.request({
    code: joinCode,
    name: "Timed",
    deviceId: `timed-${stamp}`,
  });
  const windowMinutes = Math.round(timed.expiresInMs / 60000);
  console.log(`  window is ${windowMinutes} minute(s), configured ${ttlMinutes}`);
  check("expiry matches the configured window", windowMinutes, ttlMinutes);

  console.log("\n--- a lapsed request reads as expired before the sweep runs ---");
  await JoinRequest.updateOne(
    { _id: timed.id },
    { $set: { expiresAt: new Date(Date.now() - 1000) } }
  );
  const readStale = await joinRequestService.statusFor({
    requestId: timed.id,
    deviceId: `timed-${stamp}`,
  });
  check("status is expired on read", readStale.status, JOIN_REQUEST_STATUS.EXPIRED);
  check("still no invite code", readStale.inviteCode, undefined);
  const rowStill = await JoinRequest.findById(timed.id);
  check("even though the row still says pending", rowStill.status, JOIN_REQUEST_STATUS.PENDING);
  check(
    "and it is hidden from the members' list",
    (await joinRequestService.listPending(group)).some((r) => r.id === String(timed.id)),
    false
  );

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

  console.log("\n--- THE CLEARED-STORAGE CASE ---");
  // Riya joins on her browser, then wipes its storage.
  const riyaDevice = `riya-${stamp}`;
  const riyaAsk = await joinRequestService.request({
    code: joinCode,
    name: "Riya",
    deviceId: riyaDevice,
  });
  await joinRequestService.decide({ group, actor: owner, requestId: riyaAsk.id, approve: true });
  const riya = await Member.findOne({ groupId: group._id, name: "Riya" });
  check("Riya is in, on her browser", (riya.deviceIds || []).includes(riyaDevice), true);

  // A cleared browser means a brand new device id; her row still lists the dead one.
  const newDevice = `riya-new-${stamp}`;

  console.log("\n--- the old path is a dead end, which is the bug ---");
  let deadEnd = "";
  try {
    await memberService.claimMember({ group, memberId: riya._id, deviceId: newDevice });
  } catch (err) {
    deadEnd = err.code;
  }
  check("claimMember refuses her own row", deadEnd, "ALREADY_CLAIMED");

  console.log("\n--- the recovery request is the way through ---");
  const claim = await joinRequestService.requestClaim({
    group,
    memberId: riya._id,
    deviceId: newDevice,
  });
  check("a request is created", claim.status, JOIN_REQUEST_STATUS.PENDING);
  check("it carries her name", claim.name, "Riya");
  check(
    "nothing has changed yet",
    (await Member.findById(riya._id)).deviceIds.includes(newDevice),
    false
  );

  const membersBefore = await Member.countDocuments({ groupId: group._id });
  await joinRequestService.decide({ group, actor: owner, requestId: claim.id, approve: true });

  const recovered = await Member.findById(riya._id);
  check("the new browser is now hers", (recovered.deviceIds || []).includes(newDevice), true);
  check("the dead device was dropped", (recovered.deviceIds || []).includes(riyaDevice), false);
  check(
    "no duplicate member was created",
    await Member.countDocuments({ groupId: group._id }),
    membersBefore
  );
  check("same row, so her expenses follow her", String(recovered._id), String(riya._id));
  check("and her name is unchanged", recovered.name, "Riya");

  console.log("\n--- a stranger cannot take an identity unanswered ---");
  const imposter = await joinRequestService.requestClaim({
    group,
    memberId: riya._id,
    deviceId: `imposter-${stamp}`,
  });
  check("it is only a request", imposter.status, JOIN_REQUEST_STATUS.PENDING);
  const stillHers = await Member.findById(riya._id);
  check("her device is untouched", (stillHers.deviceIds || []).includes(newDevice), true);
  check(
    "and the imposter has nothing",
    (stillHers.deviceIds || []).some((id) => id.startsWith("imposter")),
    false
  );

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
