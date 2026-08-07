const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");

const config = require("./config/env");
const corsMiddleware = require("./config/cors");
const deviceContext = require("./middlewares/deviceContext");
const errorMiddleware = require("./middlewares/error.middleware");
const { globalLimiter } = require("./middlewares/rateLimiter");
const { ERROR_CODES } = require("./constants");
const logger = require("./utils/logger");

const app = express();

/**
 * Behind nginx, Cloudflare or a platform router, the socket address is the
 * proxy's — so `req.ip` is the same value for every user and every rate limiter
 * shares one bucket. Telling Express how many hops to skip makes `req.ip` the
 * real caller again.
 *
 * See config/env.js for why this is a hop count rather than `true`: `true`
 * trusts the part of `X-Forwarded-For` the client wrote, which hands anyone a
 * fresh IP per request and makes the limiters decorative.
 */
app.set("trust proxy", config.trustProxy);

/**
 * Say once, at boot, what the server believes about who is calling it.
 *
 * This misconfiguration is invisible until it matters: everything works, and the
 * only symptom is that rate limits apply to the whole world at once. A line in
 * the startup log is the cheapest way to notice the setting is wrong before a
 * user does.
 */
if (config.trustProxy === false) {
  logger.info(
    "[proxy] trust proxy is off — client IPs come straight from the socket. " +
    "If this server sits behind nginx, Cloudflare or a platform router, set TRUST_PROXY " +
    "to the number of proxies in front of it or every user shares one rate-limit bucket."
  );
} else {
  logger.info(`[proxy] trust proxy: ${JSON.stringify(config.trustProxy)} — client IPs read from X-Forwarded-For`);
}

/**
 * Which address the limiters are actually keying on, on demand.
 *
 * Answers "is my proxy configuration right?" without reading a stack trace:
 * `GET /api/health/ip` returns what this server thinks the caller is, alongside
 * the raw header it derived it from. If `ip` is your proxy's address rather than
 * yours, `TRUST_PROXY` is too low; if the two disagree in a way you did not
 * expect, it is too high.
 */
app.get("/api/health/ip", (req, res) =>
  res.json({
    success: true,
    data: {
      /** What every rate limiter uses as its key. */
      ip: req.ip,
      /** The chain as received. The leftmost entry is client-supplied and unverified. */
      xForwardedFor: req.headers["x-forwarded-for"] || null,
      /** The socket peer — your proxy, when there is one. */
      remoteAddress: req.socket?.remoteAddress || null,
      trustProxy: config.trustProxy,
      /** Everything Express resolved, nearest first. */
      ips: req.ips,
    },
  })
);

/**
 * Middleware order is load-bearing — see docs/03-LLD.md §3.
 */

app.use(helmet());

/**
 * Invite codes are capability URLs: possession grants access. Keeping them out of
 * search indexes and third-party referrer logs is a cheap, meaningful mitigation.
 * See docs/02-HLD.md §3.4.
 */
app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(corsMiddleware);
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true }));

if (!config.isProduction) {
  app.use(morgan("dev"));
}

app.use(globalLimiter);
app.use(deviceContext);

/* ------------------------------ Health check ----------------------------- */

app.get("/", (req, res) =>
  res.status(200).json({
    status: "success",
    message: "Expense Sharing API is running",
    timestamp: new Date().toISOString(),
  })
);

/* --------------------------------- Routes -------------------------------- */

app.use("/api", require("./routes"));

/* ------------------------------ 404 fallback ----------------------------- */

app.use((req, res) =>
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    code: ERROR_CODES.GROUP_NOT_FOUND,
  })
);

/* --------------------------- Terminal error handler ---------------------- */

app.use(errorMiddleware);

module.exports = app;
