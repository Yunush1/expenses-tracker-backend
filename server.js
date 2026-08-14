const http = require("http");

const config = require("./src/config/env");
const logger = require("./src/utils/logger");
const app = require("./src/app");
const { initRealtime, closeRealtime } = require("./src/realtime/io");
const { connectDB } = require("./src/config/db");
const { initFirebase } = require("./src/config/firebase");
const { initMail } = require("./src/config/mail");
const { initRedis, whenRedisSettled, closeRedis } = require("./src/config/redis");
const { startDailyNudgeJob } = require("./src/jobs/dailyNudgeJob");
const { startRecurringExpenseJob } = require("./src/jobs/recurringExpenseJob");

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

  // Same posture as Firebase: optional, logs what it did, never blocks the boot.
  // Its credential check runs in the background — see config/mail.js.
  initMail();

  // Needs Firebase up to send anything, and the database up to know who to send
  // to — so it starts last. No-ops unless NUDGE_ENABLED=true.
  startDailyNudgeJob();

  /**
   * Rent, wifi, the maid — materialised on their dates (docs/16-TODO.md §2.2).
   *
   * Started unconditionally, unlike the nudge above it: that one has nothing to do
   * without push configured, while this one has to add the rent whether or not
   * anybody can be notified about it. Needs only the database.
   */
  startRecurringExpenseJob();

  /**
   * An explicit http.Server rather than `app.listen()`, because Socket.IO has to
   * attach to the same one: a WebSocket upgrade is an HTTP request that never
   * becomes a normal response, so it is handled at the server rather than by
   * Express. `app.listen()` creates a server internally and returns it, which
   * would work too — this is the same thing said out loud, next to the line that
   * needs it.
   */
  const server = http.createServer(app);

  /**
   * Attached before the listener accepts traffic, so the first client to connect
   * cannot arrive during a window where the upgrade handler does not exist yet.
   * Optional and never fatal — see config in realtime/io.js.
   */
  initRealtime(server);

  server.listen(config.port, () => {
    logger.info(`[server] Listening on port ${config.port}`);
  });

  const shutdown = (signal) => () => {
    logger.info(`[server] ${signal} received, closing`);
    server.close(async () => {
      // Sockets are closed first: an open WebSocket keeps the server's handle
      // alive, so `server.close()` would otherwise wait for every connected
      // client to leave of its own accord before the callback ever ran.
      await closeRealtime().catch(() => {});
      // Quit rather than drop the socket, so Redis is not left holding a
      // connection until it times out on its own.
      await closeRedis().catch(() => {});
      process.exit(0);
    });
    // Belt and braces: tell live sockets to go now, rather than relying on the
    // close callback to fire promptly on a busy sheet.
    closeRealtime().catch(() => {});
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
