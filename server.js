const config = require("./src/config/env");
const logger = require("./src/utils/logger");
const app = require("./src/app");
const { connectDB } = require("./src/config/db");

logger.info(`[server] Starting in ${config.env} mode`);

const start = async () => {
  await connectDB();

  const server = app.listen(config.port, () => {
    logger.info(`[server] Listening on port ${config.port}`);
  });

  const shutdown = (signal) => () => {
    logger.info(`[server] ${signal} received, closing`);
    server.close(() => process.exit(0));
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
