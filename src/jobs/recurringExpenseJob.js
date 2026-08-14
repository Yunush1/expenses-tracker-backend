const cron = require("node-cron");
const recurringExpenseService = require("../services/recurringExpenseService");
const logger = require("../utils/logger");

/**
 * Materialises recurring expenses (docs/16-TODO.md §2.2).
 *
 * ## Why this is its own job and not a task on the nudge tick
 *
 * The nudge scheduler does not start at all when push is unconfigured — correctly,
 * since nothing it does could be delivered. Recurring expenses have nothing to do
 * with notifications: a deployment with no Firebase credentials must still add the
 * rent. Riding on that tick would have made a flatshare's rent silently depend on
 * whether push was set up.
 *
 * ## Why hourly, and why it is safe to be late
 *
 * Due dates are whole days (utils/recurrence), so the only thing the frequency
 * decides is how far into a day an expense can appear — not whether it appears at
 * all. Hourly puts it within an hour of midnight UTC. The catch-up in `dueDates`
 * is what makes lateness harmless: a process down for a day produces yesterday's
 * expenses on the next tick, dated correctly, because a due date that has passed
 * is still owed.
 *
 * A tick that overlaps its predecessor is prevented here for the sake of doing the
 * work once, but correctness does not depend on it — the idempotency key does. Two
 * servers running this job produce one expense per due date between them.
 */
const EXPRESSION = "5 * * * *";

let running = false;

const tick = async () => {
  if (running) {
    logger.warn("[recurring] Previous run still in progress — skipping this tick");
    return;
  }

  running = true;
  try {
    await recurringExpenseService.runDue();
  } catch (error) {
    // A scheduled job must never throw into the timer: an unhandled rejection here
    // takes the process down under server.js's own handler.
    logger.error(`[recurring] Run failed: ${error.stack || error.message}`);
  } finally {
    running = false;
  }
};

const startRecurringExpenseJob = () => {
  const task = cron.schedule(EXPRESSION, tick);
  logger.info("[recurring] Scheduler on — due templates are materialised hourly");
  return task;
};

module.exports = { startRecurringExpenseJob, tick, EXPRESSION };
