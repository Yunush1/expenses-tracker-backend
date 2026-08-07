const { getMessaging, isPushEnabled } = require("../config/firebase");
const pushTokenRepository = require("../repositories/pushTokenRepository");
const memberRepository = require("../repositories/memberRepository");
const groupRepository = require("../repositories/groupRepository");
const config = require("../config/env");
const { ACTIVITY_TYPES } = require("../constants");
const logger = require("../utils/logger");

/**
 * Web push, addressed by device id.
 *
 * ## Who gets a notification
 *
 * Every active member of the group except the one who caused the event — resolved
 * to devices, not to people, because that is what a token addresses. Excluding the
 * *member* rather than the originating device id is deliberate: someone who adds an
 * expense on their phone should not get a push about it on their laptop, and
 * `member.deviceIds[]` is precisely the list that makes those two the same person
 * (docs/02-HLD.md §3.2). Excluding only the calling device would notify people
 * about their own spending.
 *
 * ## Not every activity is worth a buzz
 *
 * The activity log records everything; a notification interrupts someone. Renames
 * and group-metadata edits stay in the timeline where they belong. What ships below
 * is money moving and people arriving.
 */

/** Activity types that justify interrupting someone. */
const NOTIFIABLE = new Set([
  ACTIVITY_TYPES.EXPENSE_ADDED,
  ACTIVITY_TYPES.EXPENSE_UPDATED,
  ACTIVITY_TYPES.EXPENSE_DELETED,
  ACTIVITY_TYPES.SETTLEMENT_RECORDED,
  ACTIVITY_TYPES.MEMBER_JOINED,
]);

/**
 * FCM caps a multicast at 500 tokens. A 50-member group with 8 devices each is
 * 400, so this is headroom rather than a live constraint — but a silently
 * truncated send is not a failure mode worth leaving open.
 */
const FCM_MULTICAST_LIMIT = 500;

/** Error codes that mean "this token is dead" rather than "this send failed". */
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Every device belonging to an active member of this group, except the actor's.
 * Reads both `deviceIds[]` and the legacy scalar for the same reason
 * memberRepository.findByDevice does — so this keeps working on documents written
 * before `npm run migrate:devices` ran.
 */
const collectRecipientDeviceIds = async (groupId, actorMemberId) => {
  const members = await memberRepository.findByGroup(groupId);

  const deviceIds = new Set();
  for (const member of members) {
    if (actorMemberId && String(member._id) === String(actorMemberId)) continue;
    for (const id of member.deviceIds || []) if (id) deviceIds.add(id);
    if (member.deviceId) deviceIds.add(member.deviceId);
  }

  return [...deviceIds];
};

/**
 * Data-only payload, on purpose.
 *
 * A message carrying a `notification` block is rendered by the browser itself, and
 * the SDK *also* hands it to `onBackgroundMessage` — which is how an app ends up
 * showing every push twice. Sending data only means our service worker is the one
 * and only thing that calls `showNotification`, so the tag, the body and the
 * click-through URL are ours to control. Note every value must be a string; FCM
 * rejects a data payload containing a number.
 *
 * `tokens` is marked deprecated in firebase-admin v14 in favour of `fids`, but it
 * is the correct field here and should not be "modernised": a FID identifies a
 * Firebase *installation*, which the mobile SDKs have and a browser does not. The
 * web SDK's `getToken()` hands back a registration token, so a registration token
 * is what we send.
 */
const buildMessage = ({ tokens, group, activity }) => ({
  tokens,
  data: {
    title: group.name,
    body: activity.message,
    type: activity.type,
    groupName: group.name,
    inviteCode: group.inviteCode,
    url: `${config.appBaseUrl}/g/${group.inviteCode}${
      activity.type === ACTIVITY_TYPES.SETTLEMENT_RECORDED ? "?tab=settle" : ""
    }`,
    // Collapses a burst — a four-line shop run replaces its own notification
    // instead of stacking four.
    tag: `${group.inviteCode}:${activity.type}`,
    activityId: String(activity._id || ""),
  },
  webpush: {
    headers: {
      // Matches the 4-week activity retention; a push nobody's browser collected
      // in a month is stale news.
      TTL: "2419200",
      Urgency: "normal",
    },
  },
});

/**
 * Send, then delete whatever FCM tells us is gone.
 *
 * Dead tokens are the normal state of a push system — browsers are uninstalled,
 * caches cleared, permissions revoked, and none of that reaches us until a send
 * fails. Pruning on the failure is the only cleanup signal there is.
 */
const dispatch = async ({ messaging, tokens, group, activity }) => {
  let sent = 0;
  const dead = [];

  for (const batch of chunk(tokens, FCM_MULTICAST_LIMIT)) {
    const response = await messaging.sendEachForMulticast(
      buildMessage({ tokens: batch, group, activity })
    );

    sent += response.successCount;

    response.responses.forEach((result, index) => {
      if (result.success) return;
      const code = result.error?.code;
      if (DEAD_TOKEN_CODES.has(code)) dead.push(batch[index]);
      else logger.warn(`[pushService] Send failed (${code || "unknown"}): ${result.error?.message}`);
    });
  }

  if (dead.length > 0) {
    await pushTokenRepository.removeByTokens(dead);
    logger.info(`[pushService] Pruned ${dead.length} dead token(s)`);
  }

  return { sent, pruned: dead.length };
};

/**
 * Fan an activity out to the group's other devices.
 *
 * **Never throws, never rejects.** It is called from the activity funnel, which is
 * itself best-effort by design (activityService §record): a failed notification
 * must not fail the expense that triggered it. Everything below is wrapped, and
 * the caller does not await the result.
 */
const notifyActivity = async (activity, actor) => {
  try {
    if (!isPushEnabled() || !activity || !NOTIFIABLE.has(activity.type)) return null;

    const messaging = getMessaging();
    const group = await groupRepository.findById(activity.groupId);
    if (!group) return null;

    const deviceIds = await collectRecipientDeviceIds(activity.groupId, actor?._id);
    if (deviceIds.length === 0) return null;

    const rows = await pushTokenRepository.findByDeviceIds(deviceIds);
    const tokens = rows.map((row) => row.token).filter(Boolean);
    if (tokens.length === 0) return null;

    return await dispatch({ messaging, tokens, group, activity });
  } catch (err) {
    logger.error(`[pushService] Notification for ${activity?.type} failed: ${err.message}`);
    return null;
  }
};

/**
 * Register or refresh one browser's token.
 *
 * The reminder's next due-time is computed here, at registration, rather than
 * discovered by the scheduler scanning everybody. Required lazily: this module is
 * loaded by activityService, and dailyNudgeService loads pushTokenRepository, so
 * a top-level require would close a cycle.
 */
const registerToken = async ({ deviceId, token, userAgent, timeZone }) => {
  // eslint-disable-next-line global-require -- see above
  const { computeNextNudgeAt } = require("./dailyNudgeService");
  // eslint-disable-next-line global-require -- same cycle: points reads the User
  const pointsService = require("./pointsService");

  const row = await pushTokenRepository.upsert({
    deviceId,
    token,
    userAgent,
    timeZone,
    nextNudgeAt: computeNextNudgeAt(deviceId, timeZone),
  });

  // Best effort and unawaited: a points failure must not fail the registration
  // that someone just granted browser permission for.
  pointsService.awardNotificationsEnabled(deviceId).catch(() => {});

  return row;
};

/**
 * "Someone wants to join" — the one notification that carries buttons.
 *
 * ## Why the recipient's own device id is in the payload
 *
 * The service worker has to be able to call the API when Accept is tapped, and it
 * cannot read `localStorage` to find out which browser it is. Rather than invent a
 * signed action token, the payload simply carries the id of the device it is being
 * delivered *to* — which that device already knows, so nothing is disclosed. The
 * decide endpoint then re-checks that the id belongs to an active member of the
 * group, exactly as it would for a tap inside the app.
 *
 * Each device therefore gets its own message. That is a send per member instead of
 * one multicast, which is the cost of the buttons working; a join request is rare
 * and a group is at most fifty people.
 */
const notifyJoinRequest = async ({ group, joinRequest }) => {
  try {
    if (!isPushEnabled()) return null;

    const messaging = getMessaging();

    // Everyone already in, minus the person asking — their device is not a member
    // yet, so it is not in this list anyway.
    const members = await memberRepository.findByGroup(group._id);
    const deviceIds = [
      ...new Set(members.filter((m) => m.isActive).flatMap((m) => m.deviceIds || [])),
    ].filter((id) => id && id !== joinRequest.deviceId);

    if (deviceIds.length === 0) return null;

    const rows = await pushTokenRepository.findByDeviceIds(deviceIds);
    if (rows.length === 0) return null;

    const dead = [];
    let sent = 0;

    for (const row of rows) {
      const message = {
        token: row.token,
        data: {
          title: group.name,
          body: `${joinRequest.name} wants to join`,
          type: "JOIN_REQUEST",
          groupName: group.name,
          inviteCode: group.inviteCode,
          requestId: String(joinRequest._id),
          requesterName: joinRequest.name,
          /** The recipient's own id — see above. */
          deviceId: row.deviceId,
          url: `${config.appBaseUrl}/g/${group.inviteCode}?requests=1`,
          // Per-request, so two people asking produce two notifications rather
          // than one replacing the other.
          tag: `${group.inviteCode}:join:${joinRequest._id}`,
        },
        webpush: {
          headers: {
            // Shorter than the activity TTL: this one has a 24h deadline, and a
            // notification delivered after it expires can only disappoint.
            TTL: "86400",
            Urgency: "high",
          },
        },
      };

      try {
        // eslint-disable-next-line no-await-in-loop -- one per device, see above
        await messaging.send(message);
        sent += 1;
      } catch (err) {
        if (DEAD_TOKEN_CODES.has(err?.code)) dead.push(row.token);
        else logger.warn(`[pushService] Join request send failed: ${err.message}`);
      }
    }

    if (dead.length > 0) await pushTokenRepository.removeByTokens(dead);

    logger.info(`[pushService] Join request → ${sent} device(s)`);
    return { sent };
  } catch (err) {
    logger.warn(`[pushService] notifyJoinRequest failed: ${err.message}`);
    return null;
  }
};

/** "You're in" — or not. Sent to the requester's device only. */
const notifyJoinDecision = async ({ group, joinRequest, approved }) => {
  try {
    if (!isPushEnabled()) return null;

    const rows = await pushTokenRepository.findByDeviceIds([joinRequest.deviceId]);
    if (rows.length === 0) return null;

    const messaging = getMessaging();

    await Promise.all(
      rows.map((row) =>
        messaging
          .send({
            token: row.token,
            data: {
              title: group.name,
              body: approved
                ? `You're in — tap to open ${group.name}`
                : `Your request to join ${group.name} wasn't accepted`,
              type: approved ? "JOIN_APPROVED" : "JOIN_DECLINED",
              groupName: group.name,
              /**
               * The invite code travels only on approval. A declined requester's
               * device must not end up holding the key it was refused.
               */
              ...(approved ? { inviteCode: group.inviteCode } : {}),
              url: approved ? `${config.appBaseUrl}/g/${group.inviteCode}` : `${config.appBaseUrl}/`,
              tag: `join-decision:${joinRequest._id}`,
            },
            webpush: { headers: { TTL: "86400", Urgency: "high" } },
          })
          .catch(() => null)
      )
    );

    return { sent: rows.length };
  } catch (err) {
    logger.warn(`[pushService] notifyJoinDecision failed: ${err.message}`);
    return null;
  }
};

const unregisterDevice = (deviceId) => pushTokenRepository.removeByDeviceId(deviceId);

/** What this device has switched on. Unregistered devices report the defaults. */
const getPreferences = async (deviceId) => {
  const row = await pushTokenRepository.findByDeviceId(deviceId);
  return {
    registered: Boolean(row),
    // `!== false` so a row written before this field existed reads as on, which
    // is the default — otherwise the switch would render blank for them.
    dailyNudge: row ? row.dailyNudgeEnabled !== false : true,
  };
};

const setDailyNudge = async (deviceId, enabled) => {
  const row = await pushTokenRepository.setDailyNudge(deviceId, enabled);
  return { registered: Boolean(row), dailyNudge: row ? row.dailyNudgeEnabled : enabled };
};

module.exports = {
  notifyActivity,
  notifyJoinRequest,
  notifyJoinDecision,
  registerToken,
  unregisterDevice,
  getPreferences,
  setDailyNudge,
  NOTIFIABLE,
};
