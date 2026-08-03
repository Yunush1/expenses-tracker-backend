const mongoose = require("mongoose");
const config = require("./env");
const logger = require("../utils/logger");

/**
 * Multi-document writes (create group + creator member + activity) are only
 * transactional on a replica set. Rather than crashing on a standalone dev
 * mongod, we detect support once at connect time and let services fall back to
 * sequential writes with explicit compensation.
 */
let transactionsSupported = false;

const connectDB = async () => {
  try {
    logger.info("[db] Connecting to MongoDB...");
    await mongoose.connect(config.mongoUri);

    const { setName } = await mongoose.connection.db.admin().command({ hello: 1 });
    transactionsSupported = Boolean(setName);

    logger.info(
      `[db] Connected — transactions ${transactionsSupported ? "enabled" : "unavailable (standalone server)"}`
    );
  } catch (err) {
    logger.error(`[db] Connection failed: ${err.message}`);
    process.exit(1);
  }
};

const supportsTransactions = () => transactionsSupported;

/**
 * Runs `fn` inside a transaction when the deployment supports it, otherwise
 * calls it with a null session. Callers must handle their own compensation in
 * the non-transactional path.
 */
const withTransaction = async (fn) => {
  if (!transactionsSupported) {
    return fn(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = { connectDB, supportsTransactions, withTransaction };
