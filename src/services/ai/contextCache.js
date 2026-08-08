const { getRedis, isRedisReady } = require("../../config/redis");
const logger = require("../../utils/logger");

/**
 * A short-lived cache for the assistant's finance snapshot.
 *
 * ## Why this is worth caching at all
 *
 * `financeContext.build` is the most expensive read in the app: a ledger
 * summary, every debt, and then per group a balance computation, an expense
 * page, a settlement page and a run of the settlement optimiser. It runs on
 * every question **and** every time the drawer opens for starter suggestions —
 * so opening Ria and asking two questions rebuilt the whole thing three times
 * from the database.
 *
 * ## Why the TTL is short, and why writes bust it explicitly
 *
 * A stale balance stated confidently is exactly the failure this feature is
 * designed to avoid (docs/10-AI-ASSISTANT.md §2), so time alone is not a good
 * enough guarantee. Two things protect freshness:
 *
 *  1. **A short TTL** — long enough to cover one sitting with the assistant,
 *     short enough that nothing drifts for long.
 *  2. **Explicit invalidation on the writer's own actions.** Someone who adds an
 *     expense and immediately asks about it gets the new number, because the
 *     write drops their key. Another member's change in a shared group is picked
 *     up within the TTL rather than instantly — named honestly here because it
 *     is the one gap, and it is a small one: the questioner is nearly always the
 *     person whose action prompted the question.
 *
 * Degrades to no caching when Redis is unavailable. Every path returns the
 * freshly built value, so a Redis outage costs speed and nothing else.
 */

const TTL_SECONDS = 120;

const key = (userId) => `ai:ctx:${String(userId)}`;

/** Cached snapshot, or null when there is nothing usable. */
const read = async (userId) => {
  if (!isRedisReady()) return null;

  try {
    const raw = await getRedis().get(key(userId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    // A cache that cannot be read is a cache miss, never an error — the caller
    // is about to build the real thing anyway.
    logger.debug?.(`[ai] Context cache read failed: ${err.message}`);
    return null;
  }
};

const write = async (userId, context) => {
  if (!isRedisReady() || !context) return;

  try {
    await getRedis().set(key(userId), JSON.stringify(context), "EX", TTL_SECONDS);
  } catch (err) {
    logger.debug?.(`[ai] Context cache write failed: ${err.message}`);
  }
};

/**
 * Drop one account's snapshot.
 *
 * Called from the write paths rather than scheduled: the point is that the
 * person who just changed something sees the change on their very next question.
 */
const invalidate = async (userId) => {
  if (!userId || !isRedisReady()) return;

  try {
    await getRedis().del(key(userId));
  } catch (err) {
    logger.debug?.(`[ai] Context cache invalidation failed: ${err.message}`);
  }
};

module.exports = { read, write, invalidate, TTL_SECONDS };
