const rateLimit = require("express-rate-limit");
const { ERROR_CODES } = require("../constants");

/**
 * The API is unauthenticated by design, so rate limits are the main defence
 * against scraping and spam. Limits are documented in docs/04-API-SPEC.md §9.
 */
const build = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({ success: false, message, code: ERROR_CODES.RATE_LIMITED }),
  });

const globalLimiter = build(15 * 60 * 1000, 300, "Too many requests. Please slow down.");

const createGroupLimiter = build(
  60 * 60 * 1000,
  20,
  "Too many groups created from this network. Try again later."
);

const writeLimiter = build(15 * 60 * 1000, 120, "Too many changes. Please slow down.");

module.exports = { globalLimiter, createGroupLimiter, writeLimiter };
