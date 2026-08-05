const LedgerEntry = require("../models/ledgerEntry");
const Ledger = require("../models/ledger");
const PushToken = require("../models/pushToken");

const { getMessaging, isPushEnabled } = require("../config/firebase");
const pushTokenRepository = require("../repositories/pushTokenRepository");
const ledgerService = require("./ledgerService");
const config = require("../config/env");
const { LEDGER_ENTRY_TYPES } = require("../constants");
const { formatMinor } = require("../utils/money");
const logger = require("../utils/logger");
const {
  localDateString,
  localMinutesSinceMidnight,
  isValidTimeZone,
} = require("../utils/localTime");

/**
 * "That ₹1,000 you lent Rahul is due today."
 *
 * Rides the scheduler the evening nudge already brought (jobs/dailyNudgeJob), so
 * this adds no new timer: the same 15-minute tick, the same per-device timezone,
 * the same evening window.
 *
 * ## Not gated by the daily-nudge switch
 *
 * The evening nudge is unsolicited, so it has an off switch. A due-date reminder
 * is the opposite: the user asked for it, explicitly, by putting a date on the
 * entry. Suppressing it with the nag's toggle would mean turning off "log your
 * spending" also silently cancels a reminder someone deliberately set — the
 * control for *these* is clearing the due date, which is the same gesture that
 * created them (docs/08-PERSONAL-LEDGER.md §10).
 *
 * ## One message per person, not per loan
 *
 * Three loans due the same day is one notification. Three separate buzzes about
 * the same thing is how someone learns to swipe them away.
 */

/** One on the due date, one a week later, then silence. */
const MAX_REMINDERS = 2;
const FOLLOW_UP_DAYS = 7;

const resolveZone = (timeZone) =>
  isValidTimeZone(timeZone) ? timeZone : config.nudge.defaultTimeZone;

const dayDiff = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/**
 * Entries whose due date has arrived, cheaply bounded before any per-user work.
 *
 * The `dueAt` bound is deliberately generous — one day past "now" — because a
 * device west of the server can still be on the previous local date. The precise
 * decision is made per owner, in their own timezone, below.
 */
const dueCandidates = (now) =>
  LedgerEntry.find({
    isDeleted: false,
    settledAt: null,
    dueAt: { $ne: null, $lte: new Date(now.getTime() + 86_400_000) },
    reminderCount: { $lt: MAX_REMINDERS },
    type: { $in: [LEDGER_ENTRY_TYPES.LENT, LEDGER_ENTRY_TYPES.BORROWED] },
  })
    .limit(2000)
    .lean();

/** The message body for one person's due entries. */
const summarise = (entries, currency) => {
  const total = entries.reduce((sum, e) => sum + ledgerService.outstandingOf(e), 0);

  if (entries.length === 1) {
    const entry = entries[0];
    const who = entry.counterpartyName || "someone";
    return entry.type === LEDGER_ENTRY_TYPES.LENT
      ? `${who} owes you ${formatMinor(ledgerService.outstandingOf(entry), currency)} — due today.`
      : `You owe ${who} ${formatMinor(ledgerService.outstandingOf(entry), currency)} — due today.`;
  }

  return `${entries.length} entries due — ${formatMinor(total, currency)} in total.`;
};

/**
 * One pass. Safe to call as often as the tick fires: the per-entry
 * `lastRemindedOn` claim makes a second run on the same local date a no-op.
 */
const run = async (now = new Date()) => {
  if (!isPushEnabled()) return { skipped: true };

  const candidates = await dueCandidates(now);
  if (candidates.length === 0) return { candidates: 0, sent: 0 };

  // Resolve owners in bulk — a query per entry is how a scheduled job becomes an
  // outage at 8pm.
  const ledgerIds = [...new Set(candidates.map((e) => String(e.ledgerId)))];
  const ledgers = await Ledger.find({ _id: { $in: ledgerIds } })
    .select("_id userId currency")
    .lean();
  const ledgerById = new Map(ledgers.map((l) => [String(l._id), l]));

  const userIds = [...new Set(ledgers.map((l) => String(l.userId)))];
  const tokens = await PushToken.find({ userId: { $in: userIds } }).lean();

  /**
   * Every browser this person is signed in on — which is why `PushToken.userId`
   * exists. A reminder that only reached the device that happened to create the
   * entry would miss the phone in their pocket.
   */
  const tokensByUser = new Map();
  for (const row of tokens) {
    const key = String(row.userId);
    if (!tokensByUser.has(key)) tokensByUser.set(key, []);
    tokensByUser.get(key).push(row);
  }

  // Group the due entries by owner, deciding per owner in their own timezone.
  const byUser = new Map();

  for (const entry of candidates) {
    const ledger = ledgerById.get(String(entry.ledgerId));
    if (!ledger) continue;

    const userKey = String(ledger.userId);
    const userTokens = tokensByUser.get(userKey) || [];
    if (userTokens.length === 0) continue; // Nowhere to send.

    // The owner's clock is the first token's zone — they are all the same person.
    const zone = resolveZone(userTokens[0].timeZone);
    const localToday = localDateString(now, zone);
    const minutes = localMinutesSinceMidnight(now, zone);

    // Same evening window as the nudge, so a reminder and a nudge never collide.
    const { startHour, endHour } = config.nudge;
    if (minutes < startHour * 60 || minutes >= endHour * 60) continue;

    const dueOn = localDateString(entry.dueAt, zone);
    const daysLate = dayDiff(dueOn, localToday);

    // Not due yet in *their* timezone.
    if (daysLate < 0) continue;
    // Already reminded today.
    if (entry.lastRemindedOn === localToday) continue;

    // First reminder lands on the due date; the follow-up a week after that one.
    if (entry.reminderCount === 0 ? daysLate < 0 : dayDiff(entry.lastRemindedOn, localToday) < FOLLOW_UP_DAYS) {
      continue;
    }

    if (!byUser.has(userKey)) {
      byUser.set(userKey, { entries: [], tokens: userTokens, currency: ledger.currency, localToday });
    }
    byUser.get(userKey).entries.push(entry);
  }

  if (byUser.size === 0) return { candidates: candidates.length, sent: 0 };

  const messaging = getMessaging();
  let sent = 0;
  const dead = [];

  for (const [, group] of byUser) {
    /**
     * Claim before sending, conditional on the date — so a restart mid-run, or a
     * second instance, cannot send the same reminder twice.
     */
    const ids = group.entries.map((e) => e._id);
    const claim = await LedgerEntry.updateMany(
      { _id: { $in: ids }, lastRemindedOn: { $ne: group.localToday } },
      { $set: { lastRemindedOn: group.localToday }, $inc: { reminderCount: 1 } }
    );
    if (claim.modifiedCount === 0) continue;

    const body = summarise(group.entries, group.currency);
    const overdue = group.entries.some(
      (e) => dayDiff(localDateString(e.dueAt, resolveZone(group.tokens[0].timeZone)), group.localToday) > 0
    );

    const message = {
      tokens: group.tokens.map((t) => t.token),
      data: {
        title: overdue ? "Overdue in your ledger" : "Due today",
        body,
        type: "LEDGER_DUE",
        groupName: "Your ledger",
        inviteCode: "",
        url: `${config.appBaseUrl}/ledger`,
        tag: "ledger:due",
        activityId: "",
      },
      webpush: { headers: { TTL: "86400", Urgency: "normal" } },
    };

    try {
      const response = await messaging.sendEachForMulticast(message);
      sent += response.successCount;
      response.responses.forEach((result, index) => {
        if (result.success) return;
        const code = result.error?.code;
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token" ||
          code === "messaging/invalid-argument"
        ) {
          dead.push(message.tokens[index]);
        }
      });
    } catch (err) {
      logger.warn(`[ledgerReminder] Send failed: ${err.message}`);
    }
  }

  if (dead.length > 0) await pushTokenRepository.removeByTokens(dead);

  const summary = { candidates: candidates.length, people: byUser.size, sent, pruned: dead.length };
  if (sent > 0) logger.info(`[ledgerReminder] ${JSON.stringify(summary)}`);
  return summary;
};

module.exports = { run, MAX_REMINDERS, FOLLOW_UP_DAYS };
