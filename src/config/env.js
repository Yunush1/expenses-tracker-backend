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
  /**
   * Optional. Shares rate-limit counters and a couple of caches across processes;
   * absent, everything falls back to in-process state. Not in REQUIRED for the
   * same reason Firebase is not — see config/redis.js.
   */
  redisUrl: (process.env.REDIS_URL || "").trim(),
  clientUrls: parseOrigins(process.env.CLIENT_URLS),
  appBaseUrl: (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/+$/, ""),

  /**
   * Deliberately NOT in REQUIRED. Push is an enhancement: an unconfigured
   * deployment should serve a working expense tracker that sends no
   * notifications, not refuse to start. See config/firebase.js.
   */
  firebase: Object.freeze({
    projectId: (process.env.FIREBASE_PROJECT_ID || "").trim(),
    clientEmail: (process.env.FIREBASE_CLIENT_EMAIL || "").trim(),
    privateKey: process.env.FIREBASE_PRIVATE_KEY || "",
  }),

  /**
   * The evening "log your expenses" nudge. Off unless switched on, because a
   * scheduled job that messages every user is not something a fresh checkout
   * should start doing by itself.
   *
   * The window is in each *device's* local time, not the server's — see
   * dailyNudgeService. `defaultTimeZone` covers browsers that decline to report
   * one.
   */
  nudge: Object.freeze({
    enabled: (process.env.NUDGE_ENABLED || "").trim().toLowerCase() === "true",
    startHour: Number(process.env.NUDGE_START_HOUR ?? 20),
    endHour: Number(process.env.NUDGE_END_HOUR ?? 22),
    defaultTimeZone: (process.env.NUDGE_DEFAULT_TZ || "Asia/Kolkata").trim(),
  }),

  /**
   * Optional generator for the nudge copy. No token means the curated pool is
   * used, which is the default and always works.
   */
  huggingFace: Object.freeze({
    token: (process.env.HUGGINGFACE_API_TOKEN || "").trim(),
    model: (process.env.HUGGINGFACE_MODEL || "meta-llama/Llama-3.1-8B-Instruct").trim(),
    baseUrl: (process.env.HUGGINGFACE_BASE_URL || "https://router.huggingface.co").replace(/\/+$/, ""),
  }),

  /**
   * The finance assistant (docs/10-AI-ASSISTANT.md).
   *
   * Deliberately generic rather than named after one vendor: the endpoint shape
   * is OpenAI's `/v1/chat/completions`, which Hugging Face's router, OpenAI,
   * Groq, Together and most others all speak. Switching provider is three env
   * vars, not a code change — pricing and capability move faster than this
   * product will, and a vendor name compiled across a dozen files is a migration
   * nobody schedules.
   *
   * Falls back to the Hugging Face values so a deployment that already
   * configured those gets the assistant without touching anything.
   */
  ai: Object.freeze({
    apiKey: (process.env.AI_API_KEY || process.env.HUGGINGFACE_API_TOKEN || "").trim(),
    baseUrl: (process.env.AI_BASE_URL || process.env.HUGGINGFACE_BASE_URL || "https://router.huggingface.co")
      .replace(/\/+$/, ""),
    model: (process.env.AI_MODEL || process.env.HUGGINGFACE_MODEL || "meta-llama/Llama-3.1-8B-Instruct").trim(),
    /**
     * Questions per account per day. Small on purpose: generous for a person,
     * useless to a script, and it bounds the bill even if everything else fails.
     */
    dailyQuota: Number(process.env.AI_DAILY_QUOTA ?? 20),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 20000),
  }),
});

module.exports = config;
