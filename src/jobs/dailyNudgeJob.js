const cron = require("node-cron");
const dailyNudgeService = require("./../services/dailyNudgeService");
const ledgerReminderService = require("./../services/ledgerReminderService");
const { isPushEnabled } = require("../config/firebase");
const config = require("../config/env");
const logger = require("../utils/logger");

/**
 * Ticks every 15 minutes, all day.
 *
 * The schedule carries no timezone on purpose. "Between 8pm and 10pm" is a
 * question about each device's own clock, and a cron expression can only express
 * one zone — whichever it picked would be wrong for everyone else. So the tick is
 * dumb and frequent, and `dailyNudgeService` decides per device whether the
 * window is currently open where that device is. Fifteen minutes bounds how late
 * anyone's slot can land, and the service's local-date claim makes extra ticks
 * free.
 */
const EXPRESSION = "*/15 * * * *";

let running = false;

const tick = async () => {
  // A run that outlasts its interval must not overlap itself. The database claim
  // would prevent duplicate sends anyway; this prevents duplicate *work*.
  if (running) {
    logger.warn("[nudge] Previous run still in progress — skipping this tick");
    return;
  }

  running = true;
  try {
    /**
     * Two jobs, one tick, run independently.
     *
     * `allSettled` rather than `all`: a failure in the evening nudge must not
     * stop a loan reminder someone explicitly asked for, and vice versa. They
     * share a schedule, not a fate.
     *
     * Ledger reminders run whether or not `NUDGE_ENABLED` is set — that flag
     * governs the unsolicited nag, while a due-date reminder was requested by
     * the act of setting a date (services/ledgerReminderService).
     */
    const results = await Promise.allSettled([
      dailyNudgeService.run(),
      ledgerReminderService.run(),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        logger.error(`[nudge] Tick task failed: ${result.reason?.stack || result.reason}`);
      }
    }
  } catch (err) {
    // A scheduled job must never throw into the timer; an unhandled rejection
    // here takes the process down under server.js's own handler.
    logger.error(`[nudge] Run failed: ${err.stack || err.message}`);
  } finally {
    running = false;
  }
};

const startDailyNudgeJob = () => {
  const { startHour, endHour, defaultTimeZone } = config.nudge;

  if (!(startHour >= 0 && endHour <= 24 && startHour < endHour)) {
    logger.error(
      `[nudge] Invalid window ${startHour}:00–${endHour}:00 — scheduler not started. ` +
        "NUDGE_START_HOUR must be less than NUDGE_END_HOUR, both within 0–24."
    );
    return null;
  }

  /**
   * The tick starts whenever push is available, not only when the nudge is on.
   *
   * `NUDGE_ENABLED` governs the *unsolicited* evening nag. Ledger due-date
   * reminders were asked for — by someone putting a date on an entry — and gating
   * them behind the nag's flag would mean a reminder silently never arriving
   * because an unrelated setting was off. Each service decides for itself whether
   * it has work; an idle tick costs one indexed query.
   */
  if (!isPushEnabled()) {
    logger.info("[nudge] Scheduler not started — push is not configured, so nothing could be sent");
    return null;
  }

  const task = cron.schedule(EXPRESSION, tick);

  logger.info(
    `[nudge] Scheduler on — ${startHour}:00–${endHour}:00 in each device's local time ` +
      `(default ${defaultTimeZone}). Evening nudge: ${config.nudge.enabled ? "on" : "off"}; ` +
      "ledger due reminders: on."
  );

  return task;
};

module.exports = { startDailyNudgeJob, tick, EXPRESSION };
