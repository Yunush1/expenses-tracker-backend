const rateLimit = require("express-rate-limit");
const RedisStore = require("rate-limit-redis").default || require("rate-limit-redis");

const { getRedis, isRedisReady, isRedisConfigured } = require("../config/redis");
const { ERROR_CODES } = require("../constants");
const logger = require("../utils/logger");

/**
 * The API is unauthenticated by design, so rate limits are the main defence
 * against scraping and spam. Limits are documented in docs/04-API-SPEC.md §9.
 *
 * ## Why the store matters, and is not merely an optimisation
 *
 * `express-rate-limit` counts in memory by default — **per process**. Behind two
 * instances that makes every documented limit twice as permissive, behind four,
 * four times. For the generous limits that is untidy. For `codeLookupLimiter` it
 * is a hole: that limiter is the entire defence on a ~37-bit join code, and
 * docs/02-HLD.md §3.4 calls it load-bearing precisely because entropy is not
 * doing the work — attempts are. A limit that quietly multiplies with instance
 * count is not the limit that was designed.
 *
 * With `REDIS_URL` set, counters are shared and the numbers below mean what they
 * say no matter how many processes are running.
 *
 * ## Degrading, not failing
 *
 * If Redis is unreachable the limiter falls back to counting in memory rather
 * than rejecting traffic it cannot count. That is the right trade for this app:
 * a weakened limit is bad, but an expense tracker that returns 429 to everyone
 * because a cache is down is worse — and the fallback is exactly the behaviour
 * the service had before Redis existed.
 */

/**
 * A store per limiter, because each keeps its own counters and they must not
 * collide in a shared keyspace.
 *
 * Chosen on whether Redis is **configured**, not on whether it happens to be
 * connected right now. A limiter picks its store once and keeps it for the life
 * of the process, so deciding on live readiness means a transient blip at boot —
 * a slow TLS handshake, one refused connect before a retry succeeds — pins that
 * limiter to in-memory counting *permanently*, long after Redis came back. That
 * is the bug this whole file exists to prevent, and it would return silently.
 *
 * `sendCommand` resolves the client per call, so a reconnect is picked up
 * automatically; and when Redis is genuinely down the command rejects, which
 * `passOnStoreError` turns into "allow the request" rather than a 500.
 */
const buildStore = (name) => {
  if (!isRedisConfigured()) return undefined;

  try {
    return new RedisStore({
      prefix: `rl:${name}:`,
      sendCommand: (...args) => {
        const client = getRedis();
        // Rejecting is the contract passOnStoreError understands. Returning
        // undefined here would look like a successful count of nothing.
        if (!client || !isRedisReady()) {
          return Promise.reject(new Error("redis unavailable"));
        }
        return client.call(...args);
      },
    });
  } catch (err) {
    logger.warn(`[rateLimiter] Redis store unavailable for "${name}", counting in memory: ${err.message}`);
    return undefined;
  }
};

const build = (name, windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildStore(name),
    /**
     * A Redis outage must not 429 — or 500 — everybody.
     *
     * The limits here protect against scraping and spam; none of them is worth
     * taking the expense tracker down for. Letting requests through while the
     * store is unreachable is the same posture the service had before Redis
     * existed, and it fails in the direction of the app still working.
     */
    passOnStoreError: true,
    handler: (req, res) =>
      res.status(429).json({ success: false, message, code: ERROR_CODES.RATE_LIMITED }),
  });

/**
 * Built on first use rather than at module load, so `initRedis()` has run and
 * `isRedisConfigured()` can answer truthfully.
 */
const lazy = (factory) => {
  let limiter = null;
  return (req, res, next) => {
    if (!limiter) limiter = factory();
    return limiter(req, res, next);
  };
};

const globalLimiter = lazy(() =>
  build("global", 15 * 60 * 1000, 300, "Too many requests. Please slow down.")
);

const createGroupLimiter = lazy(() =>
  build(
    "createGroup",
    60 * 60 * 1000,
    20,
    "Too many groups created from this network. Try again later."
  )
);

const writeLimiter = lazy(() =>
  build("write", 15 * 60 * 1000, 120, "Too many changes. Please slow down.")
);

/**
 * The strictest limit in the API, and the only one that is load-bearing rather
 * than merely polite.
 *
 * An invite code is 96 bits and cannot be guessed. A join code is ~37 bits and
 * could be, given attempts — so attempts are what we take away. Ten per quarter
 * hour is generous for someone mistyping a code read aloud across a table, and
 * useless for enumeration. See docs/02-HLD.md §3.4.
 */
const codeLookupLimiter = lazy(() =>
  build(
    "codeLookup",
    15 * 60 * 1000,
    10,
    "Too many code attempts. Wait a few minutes, or use the invite link instead."
  )
);

module.exports = { globalLimiter, createGroupLimiter, writeLimiter, codeLookupLimiter };
