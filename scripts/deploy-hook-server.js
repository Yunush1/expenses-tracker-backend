/**
 * The deploy hook, for a box that does not come with one.
 *
 *   node scripts/deploy-hook-server.js
 *
 * `services/deployHookService.js` POSTs to whatever `BLOG_DEPLOY_HOOK_URL` names
 * when a post is published, because a post is not crawlable until the static site
 * has been rebuilt around it. On Netlify, Vercel or Cloudflare Pages that URL
 * comes free — the host runs the build. On a VPS nothing is listening, so this is
 * the missing half.
 *
 * ## What it does not do
 *
 * It does not know how this site is deployed, and deliberately so. Serving the
 * built files can mean nginx pointed at a directory, a static server on a port
 * behind a reverse proxy, a container, or a shell script somebody wrote a year
 * ago and has been running by hand since. Every one of those has a different
 * cutover step, and a hook that assumed one of them would be quietly wrong on the
 * other three — or, worse, would fight the existing deploy script for ownership
 * of the web root, where the loser is whichever ran last.
 *
 * So the deployment is `DEPLOY_HOOK_COMMAND`, and this process contributes only
 * the three things that are the same everywhere: it answers fast enough, it never
 * runs two builds at once, and it is not reachable from the internet.
 *
 * ## Why it answers before the build finishes
 *
 * deployHookService gives up after ten seconds. A vite build takes minutes. If
 * this waited, every publish would report "the rebuild could not be started" to
 * the author while the rebuild ran to completion behind them — the one outcome
 * worse than no hook at all, because it teaches them to distrust a message that
 * is usually true. So the request is acknowledged and the build is detached; the
 * only thing the API learns is that the request was accepted, which is the only
 * thing it asked.
 *
 * The build's own outcome goes to this process's log. Nothing carries it back to
 * the admin panel, deliberately: a failed build leaves the previous deploy
 * serving, which is the state the site was in a minute ago, and inventing a
 * channel to report it would mean a second source of truth about what is live.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFile } = require("node:child_process");

/* ── Configuration ──────────────────────────────────────────────────────────
 * Read from the environment rather than the backend's config/env.js: this runs
 * as its own process and must not pull the API's whole configuration — and its
 * MONGO_URI — into something whose only job is to shell out to a build.
 */

const PORT = Number(process.env.DEPLOY_HOOK_PORT) || 9099;

/** The path segment that authorises a build. See the note on comparison below. */
const SECRET = (process.env.DEPLOY_HOOK_SECRET || "").trim();

/** Working directory for the command. Normally the frontend checkout. */
const CWD = (process.env.DEPLOY_HOOK_CWD || "").trim();

/**
 * The deployment itself — build *and* cutover, whatever cutover means here.
 *
 * Run through `sh -c`, so `&&` and a path to an existing script both work:
 *
 *   npm run build && pm2 restart splitly-web     # static server on a port
 *   npm run build                                # nginx serving dist/ directly
 *   /root/deploy-frontend.sh                     # a script that already exists
 *
 * A shell is safe here in a way it would not be inside the request handler: this
 * string comes from the environment at startup and nothing from the HTTP request
 * is ever interpolated into it.
 */
const COMMAND = (process.env.DEPLOY_HOOK_COMMAND || "").trim();

/**
 * A build that has not finished by now is wedged, not slow.
 *
 * Without this a hung command holds the `building` flag forever and every later
 * publish is silently coalesced into a build that will never run — the site
 * stops updating and nothing reports it.
 */
const TIMEOUT_MS = Math.max(1, Number(process.env.DEPLOY_HOOK_TIMEOUT_MIN) || 15) * 60 * 1000;

const missing = Object.entries({
  DEPLOY_HOOK_SECRET: SECRET,
  DEPLOY_HOOK_CWD: CWD,
  DEPLOY_HOOK_COMMAND: COMMAND,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length) {
  console.error(`[deploy-hook] Refusing to start — not configured: ${missing.join(", ")}`);
  process.exit(1);
}

/**
 * Short secrets are the failure this is guarding against, not typos.
 *
 * The endpoint is on loopback, so this is defence in depth rather than the only
 * lock — but "the only lock" is one misconfigured proxy away from being true, and
 * a guessable path is then a stranger spending the box's CPU on builds.
 */
if (SECRET.length < 24) {
  console.error("[deploy-hook] Refusing to start — DEPLOY_HOOK_SECRET is too short to be one.");
  console.error("[deploy-hook] Generate one with: openssl rand -hex 32");
  process.exit(1);
}

const log = (message) => console.log(`[deploy-hook] ${new Date().toISOString()} ${message}`);

/* ── Authorisation ────────────────────────────────────────────────────────── */

const EXPECTED_PATH = `/deploy/${SECRET}`;

/**
 * Constant-time, and length-independent.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the secret's
 * length through the difference between a thrown 500 and a returned 404. Hashing
 * both sides first makes every comparison the same 32 bytes, so the only thing an
 * attacker learns from timing is that the server hashed two strings.
 */
const authorised = (candidate) => {
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(EXPECTED_PATH).digest();
  return crypto.timingSafeEqual(a, b);
};

/* ── The deploy ───────────────────────────────────────────────────────────── */

/**
 * Runs COMMAND to completion. Rejects on a non-zero exit or the timeout.
 *
 * Note what the frontend build does and does not guarantee: it fetches the
 * published archive from VITE_API_BASE_URL (build/blogFeed.js), and if the API is
 * unreachable it *warns and ships the site without pre-rendered posts* rather
 * than failing. A zero exit code therefore means "a site was built", not "the new
 * post is in it". That warning is in the output below, which is why the output is
 * logged on success and not only on failure.
 */
const runDeploy = (reason) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    log(`Deploy starting — ${reason}`);

    execFile(
      "sh",
      ["-c", COMMAND],
      {
        cwd: CWD,
        timeout: TIMEOUT_MS,
        // A vite build over a large tree prints more than the 1 MB default and
        // would otherwise be killed for exceeding it, mid-build, and reported as
        // a crash.
        maxBuffer: 32 * 1024 * 1024,
        // Kept out of the child: it has no use for the secret, and a build script
        // that echoes its environment for debugging should not be able to print
        // it into a log.
        env: { ...process.env, DEPLOY_HOOK_SECRET: undefined },
      },
      (error, stdout, stderr) => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();

        if (error) {
          reject(new Error(`exited ${error.code ?? error.signal} after ${seconds}s\n${output}`));
          return;
        }

        log(`Deploy finished in ${seconds}s`);
        if (output) log(`Output:\n${output}`);
        resolve();
      }
    );
  });

/* ── Coalescing ───────────────────────────────────────────────────────────── */

/**
 * deployHookService deliberately does not debounce — it says so, and it is right
 * to: on a managed host the redundant builds are the host's problem and it
 * cancels them. Here they are this box's problem, and two or three concurrent
 * vite builds on a VPS that is also running several other apps is an
 * out-of-memory kill whose victim the kernel chooses — quite possibly the API
 * rather than the build.
 *
 * So the coalescing a managed host would have done lives here instead. Requests
 * arriving during a deploy collapse into exactly one follow-up, which is the
 * correct count: the posts published while the last build ran are all in the
 * database now, and one build picks up every one of them.
 */
let building = false;
let queued = null;

const requestDeploy = (reason) => {
  if (building) {
    queued = reason;
    log(`Deploy already running — queued: ${reason}`);
    return "queued";
  }

  building = true;

  runDeploy(reason)
    .catch((error) => {
      // Swallowed on purpose: the previous deploy is still serving, so a failed
      // build is a site that is out of date, not a site that is down. Crashing
      // would turn it into one that also cannot recover on the next publish.
      log(`Deploy FAILED — ${reason}: ${error.message}`);
    })
    .finally(() => {
      building = false;
      if (queued) {
        const next = queued;
        queued = null;
        requestDeploy(next);
      }
    });

  return "started";
};

/* ── Server ───────────────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, building, queued: Boolean(queued) }));
    return;
  }

  // Everything unauthorised answers 404, not 403: a 403 confirms that /deploy/…
  // is the shape of a real endpoint and that only the secret was wrong.
  if (req.method !== "POST" || !authorised(url.pathname)) {
    req.resume();
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    // The body is a courtesy from deployHookService — a one-line reason for the
    // log. Anything larger is not that, and is not worth buffering.
    if (body.length > 4096) req.destroy();
  });

  req.on("end", () => {
    let reason = "content change";
    try {
      const parsed = JSON.parse(body || "{}");
      if (typeof parsed.trigger_title === "string") {
        // Onto one line and bounded: it is written straight into a log, and a
        // title carrying newlines could otherwise forge log entries around it.
        reason = parsed.trigger_title.replace(/\s+/g, " ").slice(0, 200);
      }
    } catch {
      // deployHookService always sends JSON; a curl by hand may not. The reason
      // is a log line, so a missing one is not a failure.
    }

    const outcome = requestDeploy(reason);

    // 202, and immediately: see the header comment. The API has ten seconds.
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true, outcome }));
  });
});

// Loopback only. This is the whole security model — the secret in the path stops
// another process on the same box from firing builds by accident, and the bind
// address stops the internet from reaching it at all. Do not change this to
// 0.0.0.0 to "test it from your laptop"; use an SSH tunnel.
server.listen(PORT, "127.0.0.1", () => {
  log(`Listening on http://127.0.0.1:${PORT}`);
  log(`Running in ${path.resolve(CWD)}: ${COMMAND}`);
  // The secret is not printed. It is the credential, and this log is a file on a
  // shared box that gets tailed, copied, and pasted into chat windows.
  log(`BLOG_DEPLOY_HOOK_URL must be http://127.0.0.1:${PORT}/deploy/<DEPLOY_HOOK_SECRET>`);
});

// PM2 sends SIGINT on restart. Finishing the in-flight deploy is not worth
// engineering around — it is idempotent and the next publish triggers another —
// but refusing new connections while it drains keeps the shutdown quiet.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`${signal} — closing.`);
    server.close(() => process.exit(0));
  });
}
