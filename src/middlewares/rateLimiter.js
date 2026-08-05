const rateLimit = require("express-rate-limit");
const RedisStore = require("rate-limit-redis").default || require("rate-limit-redis");

const { getRedis, isRedisReady } = require("../config/redis");
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
 */
const buildStore = (name) => {
  if (!isRedisReady()) return undefined;

  try {
    return new RedisStore({
      prefix: `rl:${name}:`,
      // ioredis exposes `call`; this is the adapter rate-limit-redis expects.
      sendCommand: (...args) => getRedis().call(...args),
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
    handler: (req, res) =>
      res.status(429).json({ success: false, message, code: ERROR_CODES.RATE_LIMITED }),
  });

/**
 * Built lazily, on first use, because Redis connects asynchronously during boot:
 * constructing these at module load would capture `isRedisReady() === false` and
 * pin every limiter to memory for the life of the process, silently undoing the
 * whole point.
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
