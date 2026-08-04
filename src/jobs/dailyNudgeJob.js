const cron = require("node-cron");
const dailyNudgeService = require("./../services/dailyNudgeService");
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
    await dailyNudgeService.run();
  } catch (err) {
    // A scheduled job must never throw into the timer; an unhandled rejection
    // here takes the process down under server.js's own handler.
    logger.error(`[nudge] Run failed: ${err.stack || err.message}`);
  } finally {
    running = false;
  }
};

const startDailyNudgeJob = () => {
  if (!config.nudge.enabled) {
    logger.info("[nudge] Daily reminder disabled (set NUDGE_ENABLED=true to turn it on)");
    return null;
  }

  const { startHour, endHour, defaultTimeZone } = config.nudge;

  if (!(startHour >= 0 && endHour <= 24 && startHour < endHour)) {
    logger.error(
      `[nudge] Invalid window ${startHour}:00–${endHour}:00 — reminder disabled. ` +
        "NUDGE_START_HOUR must be less than NUDGE_END_HOUR, both within 0–24."
    );
    return null;
  }

  const task = cron.schedule(EXPRESSION, tick);

  logger.info(
    `[nudge] Daily reminder on — ${startHour}:00–${endHour}:00 in each device's local time ` +
      `(default ${defaultTimeZone} when a browser doesn't say)`
  );

  return task;
};

module.exports = { startDailyNudgeJob, tick, EXPRESSION };
