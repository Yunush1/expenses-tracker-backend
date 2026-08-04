/**
 * Send the evening reminder to every registered device, right now.
 *
 *   npm run nudge:test
 *
 * A test tool. It skips the 8–10pm window, the once-a-day rule and the
 * eligibility checks, and writes no bookkeeping — so it is repeatable and cannot
 * consume a device's real reminder for today. To check the *scheduling* rules
 * rather than delivery, use `npm run nudge:dry` instead.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const { initFirebase } = require("../src/config/firebase");
const dailyNudgeService = require("../src/services/dailyNudgeService");
const logger = require("../src/utils/logger");

const dryRun = process.argv.includes("--dry");

(async () => {
  await connectDB();

  if (!initFirebase()) {
    logger.error("[nudge:test] Firebase is not configured — nothing can be sent.");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (dryRun) {
    // The real scheduled pass, against the real clock. Sends only if a device is
    // genuinely due right now, and writes bookkeeping exactly as the job would.
    const summary = await dailyNudgeService.run();
    logger.info(`[nudge:dry] ${JSON.stringify(summary)}`);
    if (summary.sent === 0) {
      logger.info(
        "[nudge:dry] Nothing was due. That is the expected result outside 20:00–22:00 local, " +
          "or for a device that has already been nudged today. Use `npm run nudge:test` to force a send."
      );
    }
  } else {
    const result = await dailyNudgeService.sendPreview();
    logger.info(`[nudge:test] ${result.sent}/${result.devices} device(s) sent`);
    for (const row of result.results || []) {
      if (row.error) logger.warn(`  ${row.device} — FAILED: ${row.error}`);
      else logger.info(`  ${row.device} → [${row.group}] "${row.line}"`);
    }
    if (result.skipped) logger.warn(`[nudge:test] Skipped: ${result.skipped}`);
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  logger.error(`[nudge:test] ${err.stack || err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
