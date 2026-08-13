const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");

const config = require("./../config/env");
const { getAuth, isAuthEnabled } = require("../config/firebase");
const { getRedis, isRedisConfigured } = require("../config/redis");
const authService = require("../services/authService");
const logger = require("../utils/logger");

/**
 * The Socket.IO server — one per process, optional, and never fatal
 * (docs/20-EXPENSE-SHEETS.md §11).
 *
 * ## What it is for, and what it is deliberately not
 *
 * It carries two things and only two: **changes to a sheet** so a second person's
 * grid updates without a refresh, and **presence** so you can see where someone
 * else's cursor is. It is not the write path. Every edit still goes over HTTP,
 * through the same validators, the same access checks and the same optimistic
 * concurrency; the socket only says *that something changed*, after it already
 * has.
 *
 * That separation is the whole safety argument. A socket message is unordered
 * with respect to HTTP, can be dropped on a flaky connection, and arrives with no
 * status code — so a client that treated it as the source of truth would
 * eventually render a sheet nobody saved. Here, the worst a lost message can do
 * is leave a grid stale until its next fetch, which is exactly where the product
 * was before real-time existed.
 *
 * ## Optional, like Firebase, Redis and SMTP
 *
 * If this fails to start, sheets keep working: edits save, and other people see
 * them when they reload. Every emitter no-ops when `getIo()` is null. There is no
 * code path where a broken socket layer can fail a write.
 *
 * ## Authentication happens twice, on purpose
 *
 * The handshake establishes *who* (a verified Firebase token, or nobody), and
 * `sheetChannel` decides *what they may see* per sheet, through the same
 * `sheetAccessService` the HTTP routes use. Neither is sufficient alone: a valid
 * token says nothing about one sheet, and a share code is not a credential for a
 * private sheet. Anonymous sockets are allowed to connect because a PUBLIC sheet
 * must work signed out — they are simply refused at the room door.
 */

let io = null;

/**
 * Origins are checked here as well as by the HTTP CORS middleware.
 *
 * Socket.IO does its own CORS: a WebSocket upgrade does not pass through Express
 * middleware, so `config/cors.js` never sees it. Left unset, the default would
 * reject every browser origin and the whole feature would silently never connect.
 */
const corsOptions = {
  origin: (origin, callback) => {
    // No origin: a native client or a server-to-server tool, not a browser.
    if (!origin) return callback(null, true);
    if (config.clientUrls.length === 0) return callback(null, true);
    if (config.clientUrls.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: true,
};

/**
 * Resolve the connecting account, or leave the socket anonymous.
 *
 * **Never rejects the connection for a bad token.** Same reasoning as
 * `optionalAuth` on the HTTP side: a public sheet must open with no account at
 * all, and a stale token in a tab left open overnight is an ordinary event, not
 * an attack. An unusable token simply means "anonymous", and `sheetChannel`
 * refuses anything that identity cannot see.
 */
const identify = async (socket, next) => {
  socket.data.user = null;

  const token = socket.handshake.auth?.token;
  if (!token || !isAuthEnabled()) return next();

  try {
    const claims = await getAuth().verifyIdToken(token);
    socket.data.user = await authService.upsertFromClaims(claims, {});
  } catch (error) {
    logger.debug?.(`[realtime] Anonymous socket (${error.message})`);
  }

  return next();
};

/**
 * Two dedicated Redis connections for the adapter — **not** the shared client.
 *
 * ## The bug this exists to prevent, because it is not obvious
 *
 * `config/redis.js` configures its client with `enableOfflineQueue: false` and
 * `maxRetriesPerRequest: 2`, deliberately: that client serves rate limiting,
 * where a command that hangs behind a dead socket is worse than one that is
 * skipped. Fail fast is exactly right there.
 *
 * It is exactly wrong here. The adapter issues `psubscribe` the instant it is
 * constructed, before a freshly duplicated connection has finished connecting —
 * so with the offline queue disabled that command is rejected outright with
 * "Stream isn't writeable and enableOfflineQueue options is false". As an
 * unhandled promise rejection it escapes the try/catch around construction
 * entirely and takes the whole process down through the handler in server.js.
 * Pub/sub wants the opposite policy from rate limiting: buffer the command and
 * send it when the socket comes up.
 *
 * `maxRetriesPerRequest: null` for the same reason — a subscription dropped
 * after two failed retries would leave this instance silently deaf to every
 * broadcast, with nothing in the logs to say so.
 *
 * They are duplicated from the configured client only to inherit the URL and TLS
 * settings; every behavioural option is overridden.
 */
const attachRedisAdapter = () => {
  try {
    const base = getRedis();
    const options = { enableOfflineQueue: true, maxRetriesPerRequest: null };

    const pub = base.duplicate(options);
    // A client in subscribe mode cannot issue ordinary commands, so the two
    // halves must be separate connections — and separate from the shared one,
    // which is busy counting rate limits.
    const sub = base.duplicate(options);

    // Without these, a Redis blip surfaces as an unhandled 'error' event on the
    // connection, which is fatal for the process. Broadcasts degrading to
    // per-instance is the correct failure here; exiting is not.
    for (const [name, client] of [["pub", pub], ["sub", sub]]) {
      client.on("error", (error) =>
        logger.warn(`[realtime] Redis ${name} connection: ${error.message}`)
      );
    }

    io.adapter(createAdapter(pub, sub));
    logger.info("[realtime] Redis adapter attached — broadcasts span instances");
  } catch (error) {
    logger.warn(
      `[realtime] Could not attach the Redis adapter, broadcasts stay within this process: ${error.message}`
    );
  }
};

const initRealtime = (httpServer) => {
  if (io) return io;

  try {
    io = new Server(httpServer, {
      cors: corsOptions,
      path: "/socket.io",
      /**
       * Polling is kept as a fallback rather than forcing pure WebSocket.
       * Corporate proxies still break upgrades, and "the grid never updates for
       * one person on the office network" is a support ticket nobody can
       * diagnose from the outside.
       */
      transports: ["websocket", "polling"],
      /** A cursor is small and frequent; a paste broadcast is not. 1MB is ample. */
      maxHttpBufferSize: 1e6,
      pingInterval: 25000,
      pingTimeout: 20000,
    });

    /**
     * Without this adapter, a broadcast only reaches sockets connected to the
     * process that emitted it. With two instances behind a load balancer, two
     * people editing the same sheet land on different processes perhaps half the
     * time — and the feature appears to work in development and to be broken,
     * intermittently and unreproducibly, in production. Redis is the same
     * optional dependency the rate limiters use, and for the same class of
     * reason: state that must be shared once there is more than one process.
     */
    if (isRedisConfigured()) attachRedisAdapter();
    else {
      logger.info(
        "[realtime] No REDIS_URL — broadcasts stay within this process. " +
          "Fine for a single instance; set REDIS_URL before running more than one."
      );
    }

    io.use(identify);

    // Registered here rather than in this file's body so the channel module owns
    // its own protocol and this one stays about transport.
    require("./sheetChannel").register(io);

    logger.info("[realtime] Socket.IO ready — live sheet updates and presence enabled");
    return io;
  } catch (error) {
    logger.error(
      `[realtime] Failed to start — sheets will work without live updates: ${error.message}`
    );
    io = null;
    return null;
  }
};

/** Null when real-time is unavailable. Every emitter checks. */
const getIo = () => io;

const isRealtimeEnabled = () => Boolean(io);

const closeRealtime = async () => {
  if (!io) return;
  await new Promise((resolve) => io.close(resolve));
  io = null;
};

module.exports = { initRealtime, getIo, isRealtimeEnabled, closeRealtime };
