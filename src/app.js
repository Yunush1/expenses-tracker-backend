const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");

const config = require("./config/env");
const corsMiddleware = require("./config/cors");
const deviceContext = require("./middlewares/deviceContext");
const errorMiddleware = require("./middlewares/error.middleware");
const { globalLimiter, networkLimiter } = require("./middlewares/rateLimiter");
const { ERROR_CODES } = require("./constants");
const receiptStorage = require("./utils/receiptStorage");
const blogStorage = require("./utils/blogStorage");
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
  /**
   * The blog is the one exception, and it has to be.
   *
   * Everything else this server answers is either behind an account or behind a
   * capability URL, so a blanket `noindex` is exactly right for it. Blog images
   * are the opposite case: they are published on purpose, they are what a search
   * result and a shared link preview show, and `noindex` on the file would keep
   * them out of Google Images and devalue the article that embeds them.
   *
   * Scoped to the served *files* rather than the JSON API. The API is not a
   * crawl surface — nothing links to it and it returns no HTML — so it keeps the
   * strict header, and only the bytes that are meant to be seen lose it.
   *
   * `Referrer-Policy` is relaxed for the same paths for a different reason: with
   * `no-referrer`, an image hotlinked from another site arrives with no
   * indication of where from, which removes the only signal that would let this
   * server ever act on it. `strict-origin-when-cross-origin` is the modern
   * default and leaks no path.
   */
  if (req.path.startsWith("/uploads/blog")) {
    res.setHeader("X-Robots-Tag", "all");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    return next();
  }

  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(corsMiddleware);

/**
 * Scanned receipt photos, served without a login.
 *
 * They have to be: every member of a group can see the expense a photo belongs to,
 * and most members have no account at all. So the **filename is the credential** —
 * 128 random bits, exactly like an invite code — and this mount is deliberately
 * thin about everything else.
 *
 * `index: false` and `redirect: false` together are what stop the directory being
 * browsable, which is the difference between "a public folder" and "an archive of
 * other people's receipts". The `X-Robots-Tag` and `Referrer-Policy` headers set
 * above apply here too, so a URL cannot leak into a search index or a third
 * party's referrer log.
 *
 * A year of caching because the name is a content address in practice: files are
 * never rewritten, only created and eventually swept, so a URL that resolves once
 * resolves to the same bytes forever.
 */
if (config.receipts.enabled) {
  app.use(
    receiptStorage.URL_PREFIX,
    express.static(receiptStorage.storageDir(), {
      index: false,
      redirect: false,
      immutable: true,
      maxAge: "365d",
      setHeaders: (res) => {
        // Nothing here is ever an executable or a page; a browser that decides
        // otherwise about an uploaded file is the classic stored-XSS route.
        res.setHeader("X-Content-Type-Options", "nosniff");
        /**
         * Overrides helmet's default of `same-origin`, which broke every photo
         * in the app.
         *
         * The frontend is served from another origin — splitly.shop against
         * api.splitly.shop in production, :5173 against :5000 in development —
         * so `same-origin` told the browser to refuse the bytes to any `<img>`
         * on the site that uploaded them. The symptom is confusing enough to be
         * worth naming: the URL opens perfectly in a new tab, because CORP does
         * not apply to a top-level navigation, and only fails when embedded.
         *
         * `cross-origin` gives up nothing here, because CORP was never what
         * protects these files. **The filename is the credential** — 128 random
         * bits, as the note above says — and CORP does not stop anyone who has a
         * URL from opening it, fetching it server-side, or saving it. It only
         * stops *embedding*, which is a hotlinking control, and hotlinking an
         * address nobody can guess is not a threat.
         *
         * `same-site` would be the tighter choice for this mount and is
         * deliberately not used: it would break any deployment that puts the API
         * on a different registrable domain than the site, which
         * `VITE_API_BASE_URL` exists to allow.
         */
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      },
    })
  );
}

/**
 * Article images, served publicly and cached hard.
 *
 * Unlike receipts, nothing here is secret — these are `<img>` tags on pages
 * built to be found. What the two mounts share is the reason the cache is safe:
 * the filename is 128 random bits and a file is never rewritten, only created,
 * so a URL that resolves once resolves to the same bytes forever.
 *
 * `index: false` and `redirect: false` keep the directory from being browsable.
 * That matters even for public files: a listing turns "the images used by the
 * blog" into "every image ever uploaded", including ones from a draft that was
 * never published or a post that was taken down.
 */
if (config.blog.imagesEnabled) {
  app.use(
    blogStorage.URL_PREFIX,
    express.static(blogStorage.storageDir(), {
      index: false,
      redirect: false,
      immutable: true,
      maxAge: "365d",
      setHeaders: (res) => {
        // An uploaded file a browser decides to treat as a document is the
        // classic stored-XSS route. Nothing in here is ever a page.
        res.setHeader("X-Content-Type-Options", "nosniff");
        /**
         * Same override as the receipts mount, and here it is not even a
         * trade-off: these images are published on purpose. They are the cover
         * on an article, the card in a shared link, the thumbnail in a search
         * result — every one of those is an embed from an origin that is not
         * this one, which is exactly what helmet's `same-origin` default
         * forbids.
         *
         * It is the same reasoning that already relaxes `X-Robots-Tag` and
         * `Referrer-Policy` for this path above.
         */
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      },
    })
  );
}

/**
 * Sheets get a larger body than everything else, and get it **first**.
 *
 * Pasting a block out of Excel is the whole point of the grid, and a few hundred
 * rows of expense data does not fit in 64kb. Raising the global limit to suit one
 * feature would hand every other endpoint — including the unauthenticated group
 * routes — a bigger buffer to be flooded with, so the allowance is scoped to the
 * routes that need it.
 *
 * Order is load-bearing: whichever parser runs first consumes the stream, and the
 * one below then sees `req._body` already set and skips. Mounted the other way
 * round, the global 64kb would win and this line would do nothing at all — which
 * would show up as a paste failing at some size nobody wrote down.
 *
 * `SHEET_MAX_BULK_ROWS` is the matching bound in the validator; the two are set
 * together, and 500 rows of ordinary data sits comfortably inside 1mb.
 */
app.use("/api/sheets", express.json({ limit: "1mb" }));

/**
 * The blog editor sends more than 64kb, in two very different sizes.
 *
 * An **image** arrives as a base64 data URL, which inflates the file by a third:
 * the 5 MB cap in `BLOG_MAX_IMAGE_MB` needs about 6.8 MB of body, and 8 MB gives
 * it room without pretending to be exact. The two are set together — raising one
 * without the other shows up as an upload failing at a size nobody wrote down.
 *
 * A **post** is HTML, and `BLOG_CONTENT_MAX` allows 400k characters, which is a
 * very long article plus TinyMCE's markup. 1 MB covers it with the same margin
 * the sheets route uses for a paste out of Excel.
 *
 * Order is load-bearing three times over. The image route must be matched before
 * the general blog route, the general blog route before the global parser, and
 * whichever runs first consumes the stream — mounted the other way round, the
 * global 64 kb would win and these lines would do nothing at all.
 *
 * Both are scoped to the admin prefix, which sits behind a verified token and
 * the operator allowlist. The public read routes take no body and are left on
 * the global limit, so nothing anonymous gains a larger buffer to be flooded
 * with.
 */
app.use("/api/blog/admin/images", express.json({ limit: "10mb" }));
app.use("/api/blog/admin", express.json({ limit: "10mb" }));

/**
 * The one route that carries a photograph, and nothing else does.
 *
 * A base64 data URL inflates the image by a third, so the 4 MB cap in
 * `AI_MAX_IMAGE_BYTES` needs roughly 5.4 MB of body — 6 MB gives it room without
 * pretending to be exact. The two are set together: raising one without the other
 * shows up as an upload failing at a size nobody wrote down, which is precisely
 * the trap the sheets note above describes.
 *
 * Scoped to the single path rather than to `/api/groups`, because the rest of that
 * router is unauthenticated and readable by anyone holding a link — handing all of
 * it a six-megabyte buffer to be flooded with would be a much larger change than
 * the feature asked for. This path is behind `requireMember`, an active group, a
 * rate limiter and a metered allowance.
 *
 * Express matches this before the global parser below, and whichever runs first
 * consumes the stream — so the order of these two lines is the whole mechanism.
 */
app.use(/^\/api\/groups\/[^/]+\/expenses\/scan-receipt$/, express.json({ limit: "6mb" }));

app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true }));

if (!config.isProduction) {
  app.use(morgan("dev"));
}

/**
 * `deviceContext` first, and the order is load-bearing.
 *
 * It sets `req.deviceId` from the `X-Device-Id` header, and `globalLimiter` keys
 * on that so a household behind one IP is not one bucket
 * (middlewares/rateLimiter.js). Mounted the other way round — as it was — the
 * limiter sees no device id, falls back to the IP for everybody, and the fix
 * silently does nothing.
 *
 * `networkLimiter` is the IP-keyed ceiling above it: the device header is
 * supplied by the client, so something has to bound a caller that rotates it.
 */
app.use(deviceContext);
app.use(networkLimiter);
app.use(globalLimiter);

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
    /**
     * `ROUTE_NOT_FOUND`, not `GROUP_NOT_FOUND`.
     *
     * This handler answers anything that matched no route — a typo, a stale
     * client calling a path that has been removed, a probe. Reporting those as
     * GROUP_NOT_FOUND meant the app showed "Group not found" for failures with
     * nothing to do with a group, and sent people to re-check an invite link that
     * was never the problem.
     */
    code: ERROR_CODES.ROUTE_NOT_FOUND,
  })
);

/* --------------------------- Terminal error handler ---------------------- */

app.use(errorMiddleware);

module.exports = app;
