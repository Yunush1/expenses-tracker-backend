const path = require("path");
const dotenv = require("dotenv");
const logger = require("../utils/logger");

/**
 * Loads .env.<NODE_ENV> (falling back to .env) and validates it.
 *
 * Config is validated at boot, not at first use: a process that starts happily
 * and then throws "MONGO_URI is undefined" on a user's first request is far
 * worse than one that refuses to start.
 */

const NODE_ENV = process.env.NODE_ENV || "development";

dotenv.config({ path: path.resolve(process.cwd(), `.env.${NODE_ENV}`) });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const REQUIRED = ["MONGO_URI"];

const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
if (missing.length > 0) {
  // eslint-disable-next-line no-console -- logger depends on config; this runs before it exists
  logger.error(
    `[config] Missing required environment variable(s): ${missing.join(", ")}\n` +
    `[config] Expected in .env.${NODE_ENV} — see .env.example`
  );
  process.exit(1);
}

const parseOrigins = (raw) =>
  (raw || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const config = Object.freeze({
  env: NODE_ENV,
  isProduction: NODE_ENV === "production",
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI,
  clientUrls: parseOrigins(process.env.CLIENT_URLS),
  appBaseUrl: (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/+$/, ""),
});

module.exports = config;
