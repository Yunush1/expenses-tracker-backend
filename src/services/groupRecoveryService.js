const Member = require("../models/member");
const Group = require("../models/group");
const User = require("../models/user");
const memberService = require("./memberService");
const { GROUP_STATUS } = require("../constants");
const logger = require("../utils/logger");

/**
 * Getting your groups back after clearing browser storage — when you have an
 * account (docs/13-JOIN-APPROVAL.md §11).
 *
 * ## Why an account changes the answer
 *
 * Without one, "I am Riya" from an unknown browser is unverifiable: the invite
 * link is shared in a group chat, so anyone holding it could say the same thing.
 * That case needs a human to confirm, which is what `requestClaim` is for.
 *
 * With one, there is real evidence. `User.deviceIds[]` accumulates every browser
 * the account has signed in on, and a member row records the browsers that acted
 * as that member. If member M carries device X, and X belongs to this account and
 * **only** this account, then M was used by a browser this person was signed into.
 * That is a fact the server can check, not a claim it has to take on trust.
 *
 * ## The ambiguity that stops it
 *
 * A browser is not a person. If two accounts have signed in on device X — a
 * shared laptop, a phone handed over — then X tells us nothing about whose member
 * row M is, and restoring would hand one flatmate the other's identity and
 * balance. That is the same leak `authService.linkDevice` refuses to allow, and
 * the same rule `ledgerMirrorService.resolveOwner` applies: **more than one
 * claimant means no answer.**
 *
 * Those memberships are skipped here and fall back to the ask-a-human path, which
 * can tell the difference.
 *
 * ## Why it is offered rather than done
 *
 * Nothing here runs on sign-in. Silently rejoining somebody to four groups
 * because they logged in is a surprising amount of reach, and the person may have
 * left one of them deliberately. The API finds them; the user picks.
 */

/**
 * Device ids that belong to this account and to nobody else.
 *
 * One query rather than one per device: a `$in` over the account's own ids finds
 * every user sharing any of them, and anything appearing under another account is
 * dropped.
 */
const unambiguousDevices = async (user) => {
  const mine = (user.deviceIds || []).filter(Boolean);
  if (mine.length === 0) return [];

  const others = await User.find({
    _id: { $ne: user._id },
    deviceIds: { $in: mine },
  })
    .select("deviceIds")
    .lean();

  const shared = new Set(others.flatMap((row) => row.deviceIds || []));
  const clean = mine.filter((id) => !shared.has(id));

  if (clean.length < mine.length) {
    logger.info(
      `[recovery] Skipped ${mine.length - clean.length} device(s) shared with another account`
    );
  }

  return clean;
};

/**
 * Memberships this account can prove, that this browser does not already hold.
 *
 * @param currentDeviceId the browser asking — excluded, since a group it is
 *   already in is not lost
 */
const findRecoverable = async (user, currentDeviceId) => {
  const devices = (await unambiguousDevices(user)).filter((id) => id !== currentDeviceId);
  if (devices.length === 0) return [];

  const members = await Member.find({ deviceIds: { $in: devices }, isActive: true })
    .select("_id groupId name deviceIds")
    .lean();
  if (members.length === 0) return [];

  const groups = await Group.find({
    _id: { $in: [...new Set(members.map((m) => String(m.groupId)))] },
    status: GROUP_STATUS.ACTIVE,
  })
    .select("_id name inviteCode memberCount lastActivityAt")
    .sort({ lastActivityAt: -1 })
    .lean();

  const groupById = new Map(groups.map((group) => [String(group._id), group]));

  return members
    .filter((member) => {
      const group = groupById.get(String(member.groupId));
      if (!group) return false;
      // Already reachable from this browser — nothing to restore.
      return !(member.deviceIds || []).includes(currentDeviceId);
    })
    .map((member) => {
      const group = groupById.get(String(member.groupId));
      return {
        memberId: String(member._id),
        memberName: member.name,
        groupName: group.name,
        inviteCode: group.inviteCode,
        memberCount: group.memberCount,
        lastActivityAt: group.lastActivityAt,
      };
    });
};

/**
 * Attach this browser to the memberships the account can prove.
 *
 * **Adds** the device rather than replacing what is there. The old id may belong
 * to a browser that still works — someone adding a laptop to a phone — and
 * dropping it would sign them out of a device they never asked to lose. The
 * ask-a-human path replaces, because there the old storage is known to be gone.
 *
 * @param only  optional list of memberIds; omitted means everything found
 */
const restore = async (user, currentDeviceId, only = null) => {
  if (!currentDeviceId) return { restored: [], skipped: 0 };

  const available = await findRecoverable(user, currentDeviceId);
  const wanted = only?.length
    ? available.filter((row) => only.includes(row.memberId))
    : available;

  const restored = [];
  let skipped = 0;

  for (const row of wanted) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a handful of groups at most
      const group = await Group.findOne({ inviteCode: row.inviteCode });
      if (!group) {
        skipped += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop -- see above
      await memberService.attachDevice({
        group,
        memberId: row.memberId,
        deviceId: currentDeviceId,
        replaceExisting: false,
      });

      restored.push(row);
    } catch (err) {
      // One group failing must not cost the others. The commonest cause is a
      // member removed from the group since they last opened it.
      skipped += 1;
      logger.warn(`[recovery] Could not restore ${row.groupName}: ${err.message}`);
    }
  }

  return { restored, skipped };
};

module.exports = { findRecoverable, restore, unambiguousDevices };
