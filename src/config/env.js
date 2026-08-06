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

/** The hard ceiling on referral depth, whatever the environment asks for. */
const MAX_REFERRAL_DEPTH = 5;

/**
 * `"50,25,12.5"` → `[50, 25, 12.5]`. Falls back to the default on anything
 * unusable, because a typo here must not silently switch referrals off — or,
 * worse, leave one level paying `NaN` points.
 */
const parsePercents = (raw, fallback) => {
  const parsed = (raw || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, MAX_REFERRAL_DEPTH);

  if (parsed.length === 0) {
    if (raw?.trim()) {
      logger.warn(`[config] REFERRAL_LEVEL_PERCENTS="${raw}" is unusable — using the default`);
    }
    return Object.freeze([...fallback]);
  }

  return Object.freeze(parsed);
};

/**
 * Resolved once, before `config`, because `levels` is derived from two other
 * settings — a getter would recompute (and re-freeze) the array on every read,
 * and this is consulted on the hot path of awarding points.
 */
const referralConfig = (() => {
  const basePoints = Math.max(1, Number(process.env.REFERRAL_BASE_POINTS ?? 100));
  const percents = parsePercents(process.env.REFERRAL_LEVEL_PERCENTS, [50, 25, 10]);

  const total = percents.reduce((sum, percent) => sum + percent, 0);
  if (total > 100) {
    // Not refused: an operator may genuinely want to pay out more than the pot.
    // But it is almost always a typo, and the cost lands on the AI bill.
    logger.warn(
      `[config] REFERRAL_LEVEL_PERCENTS sums to ${total}% — one referral now pays out ` +
      `more than REFERRAL_BASE_POINTS (${basePoints})`
    );
  }

  return Object.freeze({
    enabled: (process.env.REFERRAL_ENABLED ?? "true").toLowerCase() !== "false",
    /** What one qualified referral is worth in total, before the split. */
    basePoints,
    /**
     * The split, by depth. `50,25,12.5,6.25` is strict halving; `50,25,10` is the
     * default. Capped at five levels regardless of what is configured.
     */
    percents,
    /**
     * The percentages resolved to whole points.
     *
     * Points are integers — a third of a question is not a thing — so each level
     * is rounded, with a floor of 1 so that a small percentage of a small pot
     * degrades to "a little" rather than silently to nothing.
     */
    levels: Object.freeze(
      percents.map((percent) => Math.max(1, Math.round((basePoints * percent) / 100)))
    ),
    /**
     * Qualified referrals that may be credited to one account per day, per level.
     * The ceiling on how fast a leak can drain: at the defaults, a compromised or
     * industrious account earns at most 5 × 50 points a day from level one.
     */
    dailyCap: Math.max(1, Number(process.env.REFERRAL_DAILY_CAP ?? 5)),
    /** Given once, to a genuinely new account. */
    welcomeBonus: Math.max(0, Number(process.env.REFERRAL_WELCOME_BONUS ?? 50)),
    /** Extra, once, for arriving through someone's link — the invitee's half. */
    joinBonus: Math.max(0, Number(process.env.REFERRAL_JOIN_BONUS ?? 25)),
  });
})();

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
    /**
     * The free allowance for a brand new account — smaller, and paired with a
     * cheaper point price (see POINTS.AI_QUESTION_COST_NEW).
     *
     * The shape is deliberate. A new account holds the welcome bonus and little
     * else, so a *high* free quota that then falls off a cliff at full price
     * teaches someone the assistant is free right before it stops being. A modest
     * allowance with cheap top-ups means the bonus stretches to roughly the same
     * number of questions, and the price they learn is the one they will keep
     * paying once earning has caught up.
     */
    newUserQuota: Number(process.env.AI_NEW_USER_QUOTA ?? 10),
    /** How long an account counts as new, for both the quota and the price. */
    newUserDays: Number(process.env.AI_NEW_USER_DAYS ?? 7),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 20000),
  }),

  /**
   * Referral rewards (docs/12-REFERRALS.md).
   *
   * ## How a referral is priced
   *
   * One qualified referral is worth `basePoints` — a pot — and each level of the
   * upline takes a percentage of it. `REFERRAL_LEVEL_PERCENTS=50,25,12.5` with
   * the default pot of 100 means:
   *
   * > U5 joins on U4's link and starts using the app.
   * > U4 (who invited them) earns 50% → 50 points.
   * > U3 (who invited U4) earns 25% → 25 points.
   * > U2 (who invited U3) earns 12.5% → 13 points.
   * > U1 earns nothing: the list has three entries, so the chain is three deep.
   *
   * Percentages rather than absolute values because that is the shape the
   * decision actually has — "half of a referral goes to the person who made it"
   * survives a change to how much a referral is worth, whereas three absolute
   * numbers have to be re-derived every time and quietly drift out of proportion.
   * Repricing the whole scheme is one number, `REFERRAL_BASE_POINTS`.
   *
   * The length of the list **is** the depth. There is no separate depth setting
   * to fall out of step with it, and five is the hard ceiling regardless.
   *
   * Two properties of this design are load-bearing rather than cosmetic:
   *
   * 1. **The currency is closed.** Points buy AI questions inside the app. They
   *    cannot be bought, sold, transferred or withdrawn, and nothing in the
   *    product costs money to unlock. That is what separates a referral reward
   *    from a compensation plan, and it is why the depth here is safe to make
   *    configurable. If points ever become withdrawable, this is not a setting to
   *    turn up — it is a different product with a different legal shape.
   * 2. **Points cost the operator money.** Each one is a fraction of an AI call.
   *    Referral fraud is therefore not a leaderboard problem, it is a billing
   *    problem — hence `dailyCap`, hence rewarding activity rather than signups.
   *    See `referralService` for the guards that follow from this.
   */
  referral: referralConfig,

  ledger: Object.freeze({
    /**
     * Copy a signed-in person's share of a group expense into their personal
     * ledger (docs/08-PERSONAL-LEDGER.md §12).
     *
     * A switch because it writes into private data as a side effect of a group
     * action. It is on by default — a personal spending record that silently
     * omits the half of your life you split with other people is not much of a
     * record — but an operator who considers that too surprising can turn it off
     * without a deployment, and nothing else changes.
     */
    mirrorGroupExpenses:
      (process.env.LEDGER_MIRROR_GROUP_EXPENSES ?? "true").toLowerCase() !== "false",
  }),
});

module.exports = config;
