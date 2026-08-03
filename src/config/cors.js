const cors = require("cors");
const config = require("./env");
const logger = require("../utils/logger");

const fallbackOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  "https://fjtkzh1z-5174.inc1.devtunnels.ms"
];

const allowedOrigins = config.clientUrls.length > 0 ? config.clientUrls : fallbackOrigins;

/**
 * Hostnames that are always safe to allow in development: loopback and the three
 * private IPv4 ranges. Port is deliberately ignored — Vite hops to 5174 whenever
 * 5173 is taken, and testing on a phone means hitting the machine's LAN IP. Pinning
 * an exact origin list in dev just produces confusing CORS failures.
 */
const isLocalOrigin = (origin) => {
  try {
    const { hostname } = new URL(origin);

    if (["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"].includes(hostname)) return true;

    // 10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12
    return (
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  } catch {
    return false;
  }
};

logger.info(
  `[cors] Allowed origins: ${JSON.stringify(allowedOrigins)}` +
  (config.isProduction ? "" : " (+ any localhost / private-LAN origin in development)")
);

const corsOptions = {
  origin(origin, callback) {
    // Same-origin requests, curl and server-to-server calls send no Origin header.
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) return callback(null, true);

    if (!config.isProduction && isLocalOrigin(origin)) {
      logger.debug(`[cors] Allowing local dev origin: ${origin}`);
      return callback(null, true);
    }

    logger.warn(
      `[cors] Blocked origin: ${origin} — add it to CLIENT_URLS in .env.${config.env} to allow it`
    );

    const error = new Error(`Origin not allowed: ${origin}`);
    error.isCorsError = true;
    return callback(error);
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Device-Id"],
  credentials: false,
};

module.exports = cors(corsOptions);
