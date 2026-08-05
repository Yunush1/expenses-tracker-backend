const crypto = require("crypto");
const config = require("../config/env");
const { getRedis, isRedisReady } = require("../config/redis");
const logger = require("../utils/logger");

/**
 * The words in the evening nudge.
 *
 * ## Two sources, one of them always works
 *
 * A curated pool is the default and the floor. An optional Hugging Face call can
 * write a fresh line each day, and **anything it produces has to survive the same
 * gate the pool never needs**: a length cap, a character check, and a
 * profanity/topic screen. If it fails that, times out, or the service is having a
 * day, the pool answers instead and nobody notices.
 *
 * This ordering is not timidity about AI — it is that a push notification is the
 * one surface with no undo. It arrives on a lock screen, out of context, from an
 * app about money, and there is no "regenerate" button for the user. A model that
 * is charming 99 times and weird once has still shipped something weird to
 * everybody's pocket simultaneously.
 *
 * ## Who gets which line
 *
 * The pool is picked per device per day, so two people rarely get the same line
 * and nobody gets the same line twice running. A generated line is produced once
 * per day and shared by everyone that day — one API call rather than one per
 * device, which is the difference between free and a bill.
 */

/**
 * Deliberately written the way someone would actually text you: short, a bit
 * rude, never guilt-tripping. Anything that reads like a bank sending a warning
 * gets ignored, and anything that shames someone for spending gets the app
 * uninstalled.
 */
const NUDGE_POOL = [
  "Oi. What did today cost you? 👀",
  "Hi bro — expenses. Now. Before you forget. 💸",
  "That chai, that Uber, that 'small' order. Log it.",
  "Your wallet's been through things today. Tell us about it.",
  "Be honest. How much damage did today do? 😅",
  "Split it now or argue about it on Sunday. Your call.",
  "Somebody paid for something today. Was it you?",
  "Quick one — add today's spends before your memory deletes them.",
  "Future you is begging present you to log this. 🙏",
  "Receipts? In this economy? Just type it in. 😎",
  "10 seconds now saves a 20-minute argument later.",
  "Did money leave your account today? Thought so. 💀",
  "Bro. The expenses. They're not going to add themselves.",
  "Confession time — what did you spend today?",
  "Your group's balance is running on vibes right now. Fix it. 📊",
  "That thing you bought and forgot about. Yeah. That one.",
  "Add today's expenses. It's basically free therapy. 🧾",
  "Nobody's tracking your spending. That's the problem. 👀",
  "Two taps and you're done. Faster than deciding where to eat.",
  "Payday feels better when the maths is already done. Log it. ✨",
];

/**
 * Cache: one generated line per calendar day, shared by every device.
 *
 * In Redis when available, so a second API instance reuses the line rather than
 * paying for its own generation — the whole point of "one call per day" is lost
 * if it becomes one call per day *per process*. In-memory otherwise, which is
 * correct for a single instance.
 */
let cached = { on: "", line: "" };

const REDIS_KEY = (localDate) => `nudge:line:${localDate}`;
/** Long enough to cover every timezone still on that local date. */
const REDIS_TTL_SECONDS = 36 * 60 * 60;

const readSharedLine = async (localDate) => {
  if (cached.on === localDate && cached.line) return cached.line;

  if (isRedisReady()) {
    try {
      const line = await getRedis().get(REDIS_KEY(localDate));
      if (line) {
        cached = { on: localDate, line };
        return line;
      }
    } catch {
      /* fall through and generate */
    }
  }

  return null;
};

const writeSharedLine = async (localDate, line) => {
  cached = { on: localDate, line };
  if (!isRedisReady()) return;
  try {
    await getRedis().set(REDIS_KEY(localDate), line, "EX", REDIS_TTL_SECONDS);
  } catch {
    /* the in-memory copy still serves this process */
  }
};

const pickFromPool = (seed) => {
  const digest = crypto.createHash("sha256").update(String(seed)).digest();
  return NUDGE_POOL[digest.readUInt32BE(0) % NUDGE_POOL.length];
};

/**
 * Everything a generated line has to clear before it is allowed near a lock
 * screen. Each rule exists because the failure it prevents is unrecoverable.
 */
const MAX_LENGTH = 120;
const BANNED = /\b(fuck|shit|bitch|bastard|damn|hell|sex|kill|die|suicide|loan|debt|credit score|invest)\b/i;

const sanitize = (raw) => {
  if (typeof raw !== "string") return null;

  const line = raw
    // Models like to answer with a preamble, quotes, or a numbered list.
    .replace(/^\s*(?:here(?:'s| is)[^:]*:|\d+[.)]\s*)/i, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  if (line.length < 12 || line.length > MAX_LENGTH) return null;
  // Financial-advice and profanity screens. This app nudges; it does not counsel.
  if (BANNED.test(line)) return null;
  // A stray template variable or leaked instruction.
  if (/[{}<>]|http/i.test(line)) return null;

  return line;
};

const PROMPT =
  "Write ONE short, funny push notification (under 100 characters) telling someone " +
  "to log today's shared expenses in an expense-splitting app. Casual, friendly, a " +
  "little cheeky, like a friend texting. One emoji at most. No hashtags, no quotes, " +
  "no explanation — reply with the notification text only.";

/**
 * Hugging Face, via the Inference Providers router.
 *
 * The OpenAI-shaped `/v1/chat/completions` endpoint is the current surface; the
 * older `api-inference.huggingface.co/models/...` path is on the way out. Aborts
 * hard at 8 seconds: this runs inside a scheduled job with a whole window to play
 * with, but a hung socket must not wedge the job for the next device.
 */
const generateWithHuggingFace = async () => {
  const { token, model, baseUrl } = config.huggingFace;
  if (!token) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 60,
        // High enough that a daily line does not repeat itself all week.
        temperature: 1.0,
      }),
    });

    if (!response.ok) {
      logger.warn(`[nudge] Hugging Face returned ${response.status} — using the pool`);
      return null;
    }

    const body = await response.json();
    return sanitize(body?.choices?.[0]?.message?.content);
  } catch (err) {
    const reason = err.name === "AbortError" ? "timed out" : err.message;
    logger.warn(`[nudge] Hugging Face ${reason} — using the pool`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * The line for one device, on one local date.
 *
 * `localDate` is the device's own date, so the per-device pick rotates at the
 * user's midnight rather than the server's.
 */
const getLine = async ({ deviceId, localDate }) => {
  if (config.huggingFace.token) {
    const shared = await readSharedLine(localDate);
    if (shared) return shared;

    const generated = await generateWithHuggingFace();
    if (generated) {
      await writeSharedLine(localDate, generated);
      logger.info(`[nudge] Generated today's line: "${generated}"`);
      return generated;
    }
    // Fell through: cache nothing, so the next run tries again rather than
    // remembering a failure.
  }

  return pickFromPool(`${deviceId}:${localDate}`);
};

module.exports = { getLine, NUDGE_POOL, sanitize };
