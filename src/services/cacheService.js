const { getRedis, isRedisReady } = require("../config/redis");
const logger = require("../utils/logger");

/**
 * Read-through caching for the expensive GETs, keyed by a version that writes
 * bump.
 *
 * ## Why versioned keys and not TTLs alone
 *
 * `docs/05-ALGORITHMS.md` §3 states that balances are derived and never cached,
 * and the service worker config calls a replayed stale balance "exactly the bug
 * that rule exists to prevent". A plain TTL cache would break that rule: for up
 * to N seconds after someone adds an expense, the group would show the old
 * numbers, and "who owes what" is the one figure in this app that must never be
 * wrong.
 *
 * So nothing here expires its way to correctness. Every key embeds a version
 * number:
 *
 *     group:<id>:v7:member:<id>:summary
 *
 * A write calls `bumpGroup(groupId)`, the version becomes 8, and **every key at
 * v7 is instantly unreachable** — no scanning, no deleting, no key-tracking, one
 * INCR regardless of how many cached views exist. The old entries are never read
 * again and fall out on their own TTL.
 *
 * That makes the cache correct by construction rather than by luck: a reader
 * either sees the current version's entry or a miss, and a miss recomputes. The
 * rule the docs state is preserved — what is served is never a stale balance,
 * only a freshly-derived one that happened to be derived a moment ago.
 *
 * ## What still needs care
 *
 * Every write path must bump. Group writes all funnel through
 * `activityService.record`, which is why that is the hook — a service cannot
 * forget. Ledger writes bump in `ledgerService`. If a future write path does
 * neither, its readers go stale until the TTL, so the TTL stays modest as a
 * backstop rather than as the mechanism.
 *
 * ## Degradation
 *
 * No Redis, no caching. Every function falls through to the loader and the app
 * behaves exactly as it did before this file existed.
 */

/** A backstop, not the mechanism — see above. */
const DEFAULT_TTL = 300;
/** Versions must outlive the entries they guard, or a reset would revive them. */
const VERSION_TTL = 86400;

const versionKey = (scope, id) => `ver:${scope}:${String(id)}`;

/**
 * The current version for a scope, defaulting to 1.
 *
 * A missing version is not an error: Redis may have been flushed, or this may be
 * the first read. Starting at 1 and letting writes climb from there is safe,
 * because the only thing that matters is that the number *changes* on a write.
 */
const versionOf = async (scope, id) => {
  if (!isRedisReady()) return null;

  try {
    const raw = await getRedis().get(versionKey(scope, id));
    if (raw) return Number(raw);

    // SET NX so two concurrent readers cannot disagree about the starting point.
    await getRedis().set(versionKey(scope, id), "1", "EX", VERSION_TTL, "NX");
    return Number((await getRedis().get(versionKey(scope, id))) || 1);
  } catch (err) {
    logger.debug?.(`[cache] Version read failed: ${err.message}`);
    return null;
  }
};

/**
 * Invalidate everything cached for one scope, in a single operation.
 *
 * Never awaited by callers on the write path: a cache that fails to invalidate
 * must not fail the write that triggered it. The next read then serves a stale
 * entry until the TTL, which is the reason the TTL exists.
 */
const bump = async (scope, id) => {
  if (!id || !isRedisReady()) return;

  try {
    const key = versionKey(scope, id);
    await getRedis().incr(key);
    await getRedis().expire(key, VERSION_TTL);
  } catch (err) {
    logger.debug?.(`[cache] Version bump failed: ${err.message}`);
  }
};

/**
 * Read through the cache, computing on a miss.
 *
 * `scope`/`scopeId` decide what invalidates it; `suffix` distinguishes the views
 * within that scope. The suffix must include anything the payload varies by —
 * most group reads differ per viewer ("is this you?", "your balance"), so the
 * member id belongs in it. Getting that wrong serves one person another's view,
 * which is why callers pass it explicitly rather than it being inferred.
 */
const remember = async (scope, scopeId, suffix, loader, ttl = DEFAULT_TTL) => {
  if (!isRedisReady() || !scopeId) return loader();

  const version = await versionOf(scope, scopeId);
  if (version === null) return loader();

  const key = `${scope}:${String(scopeId)}:v${version}:${suffix}`;

  try {
    const hit = await getRedis().get(key);
    if (hit) return JSON.parse(hit);
  } catch (err) {
    logger.debug?.(`[cache] Read failed for ${key}: ${err.message}`);
  }

  const value = await loader();

  // `undefined` is not JSON, and caching `null` would pin a not-found answer.
  if (value !== undefined && value !== null) {
    try {
      await getRedis().set(key, JSON.stringify(value), "EX", ttl);
    } catch (err) {
      logger.debug?.(`[cache] Write failed for ${key}: ${err.message}`);
    }
  }

  return value;
};

/** Everything derived from one group: balances, summary, members, suggestions. */
const bumpGroup = (groupId) => bump("group", groupId);
/** Everything derived from one account: ledger summary, contacts, claims. */
const bumpUser = (userId) => bump("user", userId);

const rememberGroup = (groupId, suffix, loader, ttl) =>
  remember("group", groupId, suffix, loader, ttl);
const rememberUser = (userId, suffix, loader, ttl) =>
  remember("user", userId, suffix, loader, ttl);

module.exports = {
  remember,
  rememberGroup,
  rememberUser,
  bump,
  bumpGroup,
  bumpUser,
  DEFAULT_TTL,
};
