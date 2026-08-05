const config = require("./src/config/env");
const logger = require("./src/utils/logger");
const app = require("./src/app");
const { connectDB } = require("./src/config/db");
const { initFirebase } = require("./src/config/firebase");
const { initRedis, whenRedisSettled, closeRedis } = require("./src/config/redis");
const { startDailyNudgeJob } = require("./src/jobs/dailyNudgeJob");

logger.info(`[server] Starting in ${config.env} mode`);

const start = async () => {
  await connectDB();

  /**
   * Awaited, not fired and forgotten. The rate limiters choose their store on
   * first use and keep it for the process's lifetime, so a request arriving
   * before Redis is ready would pin that limiter to in-memory counting for good
   * — silently reintroducing the per-instance limits Redis was added to fix.
   * Settling first makes the choice deterministic; it never rejects, and a
   * five-second cap means an unreachable Redis delays boot, not blocks it.
   */
  initRedis();
  await whenRedisSettled();

  // After the database, before the listener: push is optional, so this logs what
  // it did and never blocks the boot (see config/firebase.js).
  initFirebase();

  // Needs Firebase up to send anything, and the database up to know who to send
  // to — so it starts last. No-ops unless NUDGE_ENABLED=true.
  startDailyNudgeJob();

  const server = app.listen(config.port, () => {
    logger.info(`[server] Listening on port ${config.port}`);
  });

  const shutdown = (signal) => () => {
    logger.info(`[server] ${signal} received, closing`);
    server.close(async () => {
      // Quit rather than drop the socket, so Redis is not left holding a
      // connection until it times out on its own.
      await closeRedis().catch(() => {});
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));
};

process.on("unhandledRejection", (err) => {
  logger.error(`[server] UNHANDLED REJECTION: ${err?.stack || err}`);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error(`[server] UNCAUGHT EXCEPTION: ${err?.stack || err}`);
  process.exit(1);
});

start();
