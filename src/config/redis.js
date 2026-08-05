const Redis = require("ioredis");
const config = require("./env");
const logger = require("../utils/logger");

/**
 * Redis, optional, and shared by whatever genuinely needs to be shared.
 *
 * ## What it is actually for here
 *
 * Not caching for its own sake — everything the API reads is either indexed or
 * cheap. It exists for state that must be **the same across processes**, and
 * today that is one correctness bug and two smaller wins:
 *
 *  1. **Rate limits.** `express-rate-limit` defaults to an in-memory store, which
 *     means each process keeps its own counter. Run two and the documented
 *     "10 attempts per 15 minutes" on the join-code lookup silently becomes 20 —
 *     and that limiter is the *only* defence on a ~37-bit code
 *     (docs/02-HLD.md §3.4). In-memory is not a performance choice there, it is a
 *     hole that opens the moment the app scales past one instance.
 *  2. **Token-revocation checks** (middlewares/requireAuth) — otherwise each
 *     process re-pays the ~335ms Firebase lookup on its own schedule.
 *  3. **The daily nudge line** (services/nudgeContentService) — otherwise each
 *     process makes its own Hugging Face call for what is meant to be one line
 *     a day.
 *
 * ## Optional, like Firebase
 *
 * No `REDIS_URL` means every one of those falls back to in-process state and the
 * API runs exactly as it does today. That is the right default for a single
 * instance, and it keeps a local checkout from needing a Redis to boot.
 *
 * ## Never fatal
 *
 * A Redis outage must not take down an expense tracker. `ioredis` reconnects on
 * its own, errors are logged and swallowed, and every consumer is written to
 * degrade rather than throw — see `rateLimiter.js`, which keeps serving on the
 * in-memory store rather than rejecting traffic it cannot count.
 */

let client = null;
let unavailableLogged = false;

const initRedis = () => {
  if (client) return client;

  const url = config.redisUrl;
  if (!url) {
    logger.info("[redis] No REDIS_URL — using in-process state (fine for a single instance)");
    return null;
  }

  try {
    client = new Redis(url, {
      // Fail fast and keep serving rather than queueing commands behind a dead
      // socket: a rate-limit check that hangs is worse than one that is skipped.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      lazyConnect: false,
      // Upstash and most hosted Redis require TLS; `rediss://` turns it on.
      retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
    });

    client.on("ready", () => {
      unavailableLogged = false;
      logger.info("[redis] Connected — rate limits and caches are now shared across instances");
    });

    client.on("error", (err) => {
      // One line per outage, not one per command.
      if (!unavailableLogged) {
        unavailableLogged = true;
        logger.warn(`[redis] Unavailable, falling back to in-process state: ${err.message}`);
      }
    });

    return client;
  } catch (err) {
    logger.error(`[redis] Could not initialise — continuing without it: ${err.message}`);
    client = null;
    return null;
  }
};

/**
 * Resolve once the connection has settled — ready or failed — so callers can be
 * sure `isRedisReady()` is telling the truth.
 *
 * This exists to close a boot race with the rate limiters. They pick their store
 * on first use and keep it for the life of the process, so a request arriving in
 * the moment between `listen()` and Redis becoming ready would pin that limiter
 * to in-memory counting **permanently** — the exact bug Redis was added to fix,
 * reintroduced by timing and invisible afterwards. Awaiting this before the
 * server accepts traffic makes the choice deterministic.
 *
 * Never rejects: a Redis that fails to connect is a degraded mode, not a failed
 * boot.
 */
const whenRedisSettled = (timeoutMs = 5000) =>
  new Promise((resolve) => {
    if (!client || client.status === "ready") return resolve(isRedisReady());

    const finish = () => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      resolve(isRedisReady());
    };
    const onReady = () => finish();
    const onError = () => finish();
    const timer = setTimeout(finish, timeoutMs);

    client.once("ready", onReady);
    client.once("error", onError);
  });

const getRedis = () => client;

/** Connected *and* ready. A connecting client cannot answer, so it does not count. */
const isRedisReady = () => Boolean(client && client.status === "ready");

/**
 * Whether Redis is *meant* to be used, regardless of whether it is up this
 * instant. Callers that make a once-per-process decision — the rate limiters
 * choosing a store — must ask this rather than `isRedisReady`, or a blip at boot
 * degrades them permanently.
 */
const isRedisConfigured = () => Boolean(client);

const closeRedis = async () => {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  client = null;
};

module.exports = {
  initRedis,
  whenRedisSettled,
  getRedis,
  isRedisReady,
  isRedisConfigured,
  closeRedis,
};
