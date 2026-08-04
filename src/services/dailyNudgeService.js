const crypto = require("crypto");

const PushToken = require("../models/pushToken");
const Member = require("../models/member");
const Group = require("../models/group");
const Expense = require("../models/expense");

const { getMessaging, isPushEnabled } = require("../config/firebase");
const pushTokenRepository = require("../repositories/pushTokenRepository");
const nudgeContentService = require("./nudgeContentService");
const config = require("../config/env");
const { GROUP_STATUS } = require("../constants");
const logger = require("../utils/logger");
const {
  localDateString,
  localMinutesSinceMidnight,
  startOfLocalDay,
  zonedTimeToUtc,
  addDays,
  isValidTimeZone,
} = require("../utils/localTime");

/**
 * The evening "log today's spending" reminder.
 *
 * ## It is a reminder, not a broadcast
 *
 * The difference is whether there is a reason to send. Browser push permission is
 * one-way — blocked is blocked forever, and it takes the transactional alerts
 * down with it — so every unnecessary message is spending the only credit this
 * app has. A device is nudged only when **all** of these hold:
 *
 *   1. the reminder is switched on for it (separate from expense alerts)
 *   2. it belongs to an active member of an ACTIVE group
 *   3. that group has seen activity recently — a trip that ended in March is not
 *      a reason to buzz someone in August
 *   4. nobody has logged an expense from it today; the reminder is redundant the
 *      moment the thing it asks for is done
 *   5. it has not already been nudged today, in its own local date
 *   6. it is between 8pm and 10pm *where the device is*
 *   7. it is not being ignored — see the back-off below
 *
 * ## Back-off
 *
 * Three nudges with nothing logged after them and the cadence drops to weekly.
 * A reminder nobody acts on is not a reminder; carrying on is how an app teaches
 * someone to block it. Logging anything resets the counter.
 */

/** Past this many unanswered, drop to roughly weekly. */
const UNANSWERED_LIMIT = 3;
const BACKOFF_DAYS = 7;
/** A group quiet for longer than this is over, whatever its status says. */
const ACTIVE_GROUP_DAYS = 14;

const dayDiff = (fromIsoDate, toIsoDate) =>
  Math.round((Date.parse(`${toIsoDate}T00:00:00Z`) - Date.parse(`${fromIsoDate}T00:00:00Z`)) / 86_400_000);

/**
 * Where in the window this device sits, as minutes past the start.
 *
 * Derived from the device id so it is stable, and so the whole population does
 * not arrive at 20:00 sharp — which would be both a visible thundering herd and
 * an obvious robot. Everyone still lands inside the window.
 */
const slotWithinWindow = (deviceId, windowMinutes) => {
  const digest = crypto.createHash("sha256").update(`nudge:${deviceId}`).digest();
  return digest.readUInt32BE(0) % windowMinutes;
};

const resolveZone = (timeZone) =>
  isValidTimeZone(timeZone) ? timeZone : config.nudge.defaultTimeZone;

/**
 * When this device is next due, as a UTC instant.
 *
 * The `Intl` work happens here — once per device per day, at registration or
 * after a send — instead of once per device per tick. That is the whole point of
 * storing it: the same answer, computed 1 time a day rather than 96.
 *
 * `afterDays` pushes the first candidate out for the weekly back-off.
 */
const computeNextNudgeAt = (deviceId, timeZone, from = new Date(), afterDays = 0) => {
  const zone = resolveZone(timeZone);
  const { startHour, endHour } = config.nudge;
  const windowMinutes = (endHour - startHour) * 60;
  const targetMinutes = startHour * 60 + slotWithinWindow(deviceId, windowMinutes);

  const firstDate = addDays(localDateString(from, zone), afterDays);

  // Today's slot may already have passed; never more than one extra day is
  // needed, but the loop makes that a property rather than an assumption.
  for (let offset = 0; offset <= 1; offset += 1) {
    const candidate = zonedTimeToUtc(addDays(firstDate, offset), targetMinutes, zone);
    if (candidate > from) return candidate;
  }

  return zonedTimeToUtc(addDays(firstDate, 2), targetMinutes, zone);
};

/**
 * Devices whose local clock is inside the window, past their slot, and not
 * already nudged today. Cheap checks only — no database work per device.
 */
const dueByClock = (tokens, now) => {
  const { startHour, endHour } = config.nudge;
  const windowMinutes = (endHour - startHour) * 60;

  return tokens.reduce((due, token) => {
    // `=== false`, not falsy: a row written before this field existed has no
    // value at all, and the default is on. Testing truthiness would silently
    // exclude every device registered before the feature shipped.
    if (token.dailyNudgeEnabled === false) return due;

    const zone = resolveZone(token.timeZone);
    const minutes = localMinutesSinceMidnight(now, zone);
    const localDate = localDateString(now, zone);

    const sinceWindowStart = minutes - startHour * 60;
    if (sinceWindowStart < 0 || sinceWindowStart >= windowMinutes) return due;
    if (sinceWindowStart < slotWithinWindow(token.deviceId, windowMinutes)) return due;

    if (token.lastNudgeOn === localDate) return due;

    // Being ignored: hold off until the back-off has elapsed.
    if (
      token.unansweredNudges >= UNANSWERED_LIMIT &&
      token.lastNudgeOn &&
      dayDiff(token.lastNudgeOn, localDate) < BACKOFF_DAYS
    ) {
      return due;
    }

    due.push({ token, zone, localDate, now });
    return due;
  }, []);
};

/**
 * Attach each candidate to the group it should link to, and work out whether its
 * owner has already logged something today.
 *
 * Done as three bulk queries rather than per device: a nudge run touches every
 * registered browser, and a query per device is how a scheduled job turns into an
 * outage at 8pm.
 */
const enrich = async (candidates) => {
  const deviceIds = candidates.map((c) => c.token.deviceId);

  const members = await Member.find({
    deviceIds: { $in: deviceIds },
    isActive: true,
  })
    .select("_id groupId deviceIds")
    .lean();

  if (members.length === 0) return [];

  const cutoff = new Date(Date.now() - ACTIVE_GROUP_DAYS * 86_400_000);
  const groups = await Group.find({
    _id: { $in: [...new Set(members.map((m) => String(m.groupId)))] },
    status: GROUP_STATUS.ACTIVE,
    lastActivityAt: { $gte: cutoff },
  })
    .select("_id name inviteCode lastActivityAt")
    .lean();

  const groupById = new Map(groups.map((g) => [String(g._id), g]));

  // Only members of a live group are worth considering further.
  const liveMembers = members.filter((m) => groupById.has(String(m.groupId)));
  if (liveMembers.length === 0) return [];

  /**
   * "Logged something today" is asked per device, and a device's day starts at
   * its own midnight — so the widest local midnight across the batch bounds the
   * query, and each device is then filtered against its own.
   */
  const earliest = new Date(
    Math.min(...candidates.map((c) => startOfLocalDay(c.now, c.zone).getTime()))
  );

  const todaysExpenses = await Expense.find({
    createdByMemberId: { $in: liveMembers.map((m) => m._id) },
    createdAt: { $gte: earliest },
    isDeleted: { $ne: true },
  })
    .select("createdByMemberId createdAt")
    .lean();

  const membersByDevice = new Map();
  for (const member of liveMembers) {
    for (const deviceId of member.deviceIds || []) {
      if (!membersByDevice.has(deviceId)) membersByDevice.set(deviceId, []);
      membersByDevice.get(deviceId).push(member);
    }
  }

  return candidates.flatMap((candidate) => {
    const owned = membersByDevice.get(candidate.token.deviceId);
    if (!owned?.length) return [];

    const ownedIds = new Set(owned.map((m) => String(m._id)));
    const dayStart = startOfLocalDay(candidate.now, candidate.zone);

    const loggedToday = todaysExpenses.some(
      (expense) =>
        ownedIds.has(String(expense.createdByMemberId)) && expense.createdAt >= dayStart
    );

    // The most recently busy group is the one they most likely want to open.
    const group = owned
      .map((m) => groupById.get(String(m.groupId)))
      .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt))[0];

    return [{ ...candidate, group, loggedToday }];
  });
};

const buildMessage = ({ token, group, line }) => ({
  token: token.token,
  data: {
    title: group.name,
    body: line,
    type: "DAILY_NUDGE",
    groupName: group.name,
    inviteCode: group.inviteCode || "",
    // The scheduled job always has a group; the preview may not. Landing on the
    // home screen — which lists this device's groups — beats `/g/` and a 404.
    url: group.inviteCode ? `${config.appBaseUrl}/g/${group.inviteCode}` : `${config.appBaseUrl}/`,
    // Its own tag, so a reminder never replaces a real expense alert.
    tag: `${group.inviteCode || "splitly"}:DAILY_NUDGE`,
    activityId: "",
  },
  webpush: {
    // Pointless after the evening it belongs to.
    headers: { TTL: "7200", Urgency: "low" },
  },
});

/**
 * How many sends are in flight at once.
 *
 * Sequential sending is the quiet failure here: at ~100ms a call, ten thousand
 * due devices take longer than the window they are supposed to arrive in, and
 * people get "log today's spending" at midnight. These are network waits, not
 * work — running them concurrently costs almost no CPU and keeps the batch inside
 * its window. Bounded so a large run cannot open ten thousand sockets at once.
 */
const SEND_CONCURRENCY = 20;

/** Run `worker` over `items`, at most `limit` at a time. */
const mapWithLimit = async (items, limit, worker) => {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      await worker(queue.shift());
    }
  });
  await Promise.all(runners);
};

/**
 * One pass. Safe to call as often as you like — the local-date claim makes a
 * second run within the same day a no-op.
 */
const run = async (now = new Date()) => {
  if (!config.nudge.enabled || !isPushEnabled()) return { skipped: true };

  const messaging = getMessaging();

  /**
   * The indexed query, and the reason this job does not scale with user count.
   *
   * Only devices whose precomputed due-time has arrived are loaded. `null` and
   * missing are included so rows written before `nextNudgeAt` existed — and
   * freshly registered ones — get picked up and backfilled on the next tick
   * rather than being invisible forever.
   *
   * `$ne: false` rather than `true` for the same migration reason: documents
   * predating `dailyNudgeEnabled` carry no value, and the default is on.
   */
  const tokens = await PushToken.find({
    dailyNudgeEnabled: { $ne: false },
    $or: [{ nextNudgeAt: { $lte: now } }, { nextNudgeAt: null }],
  })
    .limit(5000)
    .lean();

  if (tokens.length === 0) return { considered: 0, sent: 0 };

  // The wall clock remains the authority. `nextNudgeAt` is an index into the
  // population, not permission to send — a stale one (timezone changed, window
  // reconfigured) must not be able to buzz someone at 4am.
  const candidates = dueByClock(tokens, now);

  /**
   * Anything the index offered but the clock rejected gets a corrected due-time,
   * so it stops being scanned every tick. This is what backfills existing rows
   * and absorbs a timezone change.
   */
  const notDue = tokens.filter((token) => !candidates.some((c) => c.token._id === token._id));
  await Promise.all(
    notDue.map((token) =>
      PushToken.updateOne(
        { _id: token._id },
        { $set: { nextNudgeAt: computeNextNudgeAt(token.deviceId, token.timeZone, now) } }
      )
    )
  );

  if (candidates.length === 0) return { considered: tokens.length, sent: 0, rescheduled: notDue.length };

  const targets = await enrich(candidates);

  // Eligibility is decided per group/expense state; a candidate that survives the
  // clock but has no live group still needs its next due-time moved on.
  const ineligible = candidates.filter((c) => !targets.some((t) => t.token._id === c.token._id));
  await Promise.all(
    ineligible.map((c) =>
      PushToken.updateOne(
        { _id: c.token._id },
        { $set: { nextNudgeAt: computeNextNudgeAt(c.token.deviceId, c.token.timeZone, now) } }
      )
    )
  );

  let sent = 0;
  let alreadyLogged = 0;
  const dead = [];

  await mapWithLimit(targets, SEND_CONCURRENCY, async (target) => {
    const reschedule = (afterDays = 0) =>
      computeNextNudgeAt(target.token.deviceId, target.token.timeZone, now, afterDays);

    // They did the thing. Say nothing, and forgive the ignored ones.
    if (target.loggedToday) {
      alreadyLogged += 1;
      await PushToken.updateOne(
        { _id: target.token._id },
        {
          $set: {
            unansweredNudges: 0,
            lastNudgeOn: target.localDate,
            nextNudgeAt: reschedule(),
          },
        }
      );
      return;
    }

    /**
     * Claim before sending, conditional on the date not already being set.
     *
     * The write is what makes a duplicate impossible: two workers, or a restart
     * mid-run, cannot both match `lastNudgeOn: { $ne: today }`. Claiming after a
     * successful send would leave the window open between the two — which is
     * exactly the gap concurrency widens.
     */
    const claimed = await PushToken.findOneAndUpdate(
      { _id: target.token._id, lastNudgeOn: { $ne: target.localDate } },
      { $set: { lastNudgeOn: target.localDate }, $inc: { unansweredNudges: 1 } },
      { new: true }
    );
    if (!claimed) return;

    // Now that the counter has been incremented, a device that has just crossed
    // the ignore threshold waits a week rather than a day.
    await PushToken.updateOne(
      { _id: target.token._id },
      {
        $set: {
          nextNudgeAt: reschedule(claimed.unansweredNudges >= UNANSWERED_LIMIT ? BACKOFF_DAYS : 0),
        },
      }
    );

    const line = await nudgeContentService.getLine({
      deviceId: target.token.deviceId,
      localDate: target.localDate,
    });

    try {
      await messaging.send(buildMessage({ token: target.token, group: target.group, line }));
      sent += 1;
    } catch (err) {
      const code = err.code || err.errorInfo?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        dead.push(target.token.token);
      } else {
        logger.warn(`[nudge] Send failed (${code || "unknown"}): ${err.message}`);
      }
    }
  });

  if (dead.length > 0) await pushTokenRepository.removeByTokens(dead);

  const summary = {
    considered: tokens.length,
    due: candidates.length,
    eligible: targets.length,
    alreadyLogged,
    sent,
    pruned: dead.length,
    rescheduled: notDue.length + ineligible.length,
  };

  if (sent > 0 || dead.length > 0) logger.info(`[nudge] ${JSON.stringify(summary)}`);
  return summary;
};

/**
 * Send the real reminder to every registered device, right now.
 *
 * A test tool, and deliberately not just `run()` with the clock moved: it skips
 * the window, the once-a-day claim and the eligibility rules, and **writes
 * nothing**. Those rules are exactly what makes the scheduled job hard to
 * observe — you cannot see the notification without waiting for 8pm, having an
 * active group, and not having logged anything — and a preview that trips over
 * them tells you nothing about whether push works.
 *
 * Because it touches no bookkeeping it is repeatable, and it cannot consume the
 * device's real reminder for today.
 */
const sendPreview = async (now = new Date()) => {
  if (!isPushEnabled()) return { skipped: "push is not configured" };

  const messaging = getMessaging();
  const tokens = await PushToken.find().lean();
  if (tokens.length === 0) return { devices: 0, sent: 0 };

  // Reuse the real enrichment so the link and title match what the job sends,
  // but keep devices it rejects — a preview should still arrive.
  const candidates = tokens.map((token) => ({
    token,
    zone: resolveZone(token.timeZone),
    localDate: localDateString(now, resolveZone(token.timeZone)),
    now,
  }));

  const enriched = await enrich(candidates);
  const groupByDevice = new Map(enriched.map((t) => [String(t.token._id), t.group]));

  const results = [];
  const dead = [];

  await mapWithLimit(candidates, SEND_CONCURRENCY, async (candidate) => {
    const line = await nudgeContentService.getLine({
      deviceId: candidate.token.deviceId,
      localDate: candidate.localDate,
    });

    const group = groupByDevice.get(String(candidate.token._id)) || {
      name: "Splitly",
      inviteCode: "",
    };

    try {
      await messaging.send(buildMessage({ token: candidate.token, group, line }));
      results.push({ device: candidate.token.deviceId.slice(-12), group: group.name, line });
    } catch (err) {
      const code = err.code || err.errorInfo?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        dead.push(candidate.token.token);
      }
      results.push({ device: candidate.token.deviceId.slice(-12), error: code || err.message });
    }
  });

  if (dead.length > 0) await pushTokenRepository.removeByTokens(dead);

  return { devices: tokens.length, sent: results.filter((r) => !r.error).length, results };
};

module.exports = {
  run,
  sendPreview,
  dueByClock,
  computeNextNudgeAt,
  mapWithLimit,
  UNANSWERED_LIMIT,
  BACKOFF_DAYS,
  ACTIVE_GROUP_DAYS,
  SEND_CONCURRENCY,
};
