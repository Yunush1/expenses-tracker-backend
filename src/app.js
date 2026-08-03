const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");

const config = require("./config/env");
const corsMiddleware = require("./config/cors");
const deviceContext = require("./middlewares/deviceContext");
const errorMiddleware = require("./middlewares/error.middleware");
const { globalLimiter } = require("./middlewares/rateLimiter");
const { ERROR_CODES } = require("./constants");

const app = express();

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
