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
  /**
   * Every custom header the browser is allowed to send.
   *
   * This list is exact, not advisory: a header missing here fails the *preflight*,
   * so the real request is never sent — the browser reports a CORS error with no
   * response headers and zero bytes, and the server logs nothing at all because
   * nothing reached it. That makes an omission here look like a server outage or
   * a wrong CLIENT_URLS, and sends you looking in the wrong place.
   *
   * `Authorization` carries the Firebase ID token for the personal ledger. It is
   * attached only when someone is signed in, which is why forgetting it produced
   * a failure that came and went with sign-in state rather than a consistent one.
   *
   * `X-Socket-Id` is this tab's live socket, so a sheet edit is not broadcast back
   * to the client that made it (docs/20-EXPENSE-SHEETS.md §11). It was added to
   * the API client before this line, and the paragraph above describes precisely
   * what happened: every sheet request failed preflight, the browser reported
   * "Network Error" with no response, and the server logged nothing because
   * nothing arrived. **Adding a header to services/api.js means adding it here.**
   */
  allowedHeaders: [
    "Content-Type",
    "X-Device-Id",
    "Authorization",
    "X-Referral-Code",
    "X-Socket-Id",
  ],
  // Bearer tokens, not cookies — so the browser never needs to send credentials.
  credentials: false,
};

module.exports = cors(corsOptions);
