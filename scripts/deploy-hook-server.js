/**
 * The deploy hook, for a box that does not come with one.
 *
 *   node scripts/deploy-hook-server.js
 *
 * `services/deployHookService.js` POSTs to whatever `BLOG_DEPLOY_HOOK_URL` names
 * when a post is published, because a post is not crawlable until the static
 * site has been rebuilt around it. On Netlify, Vercel or Cloudflare Pages that
 * URL comes free — the host runs the build. On a VPS nothing is listening, so
 * this is the missing half: a POST here runs `npm run build` in the frontend and
 * swaps the result under nginx.
 *
 * ## Why it is a separate process and not a route on the API
 *
 * A route would be simpler by one file and wrong in two ways. It would put a
 * build trigger on the public internet behind nothing but a secret in a path,
 * and it would run a multi-minute, memory-hungry vite build inside the process
 * serving requests and holding every Socket.IO session — a `max_memory_restart`
 * away from disconnecting every user mid-build (ecosystem.config.js).
 *
 * Bound to loopback, it is reachable only by something already on the box.
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
 * Where the build's own outcome goes is PM2's log for this app. Nothing reads it
 * back into the admin panel, deliberately: a failed build leaves the previous
 * release serving, which is the state the site was in a minute ago, and inventing
 * a channel to report it would mean a second source of truth about what is live.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

/* ── Configuration ──────────────────────────────────────────────────────────
 * Read from the environment rather than the backend's config/env.js: this runs
 * as its own PM2 app and must not pull the API's whole configuration — and its
 * MONGO_URI — into a process whose only job is to shell out to npm.
 */

const PORT = Number(process.env.DEPLOY_HOOK_PORT) || 9099;

/** The path segment that authorises a build. See the note on comparison below. */
const SECRET = (process.env.DEPLOY_HOOK_SECRET || "").trim();

/** Where `npm run build` is run. The frontend checkout. */
const FRONTEND_DIR = (process.env.DEPLOY_HOOK_FRONTEND_DIR || "").trim();

/** Finished builds are kept here, one directory per release. */
const RELEASES_DIR = (process.env.DEPLOY_HOOK_RELEASES_DIR || "").trim();

/** The symlink nginx's `root` points at. Swung atomically at the end of a build. */
const CURRENT_LINK = (process.env.DEPLOY_HOOK_CURRENT_LINK || "").trim();

/**
 * How many past releases survive.
 *
 * Not zero, because the reason to keep them is a rollback that has to work while
 * the site is broken — `ln -sfn releases/<previous> current` is the whole
 * procedure, and it needs the previous build to still exist.
 */
const KEEP_RELEASES = Math.max(1, Number(process.env.DEPLOY_HOOK_KEEP) || 3);

/**
 * A build that has not finished by now is wedged, not slow.
 *
 * Without this a hung npm holds the `building` flag forever and every later
 * publish is silently coalesced into a build that will never run — the site
 * stops updating and nothing reports it.
 */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

const missing = Object.entries({
  DEPLOY_HOOK_SECRET: SECRET,
  DEPLOY_HOOK_FRONTEND_DIR: FRONTEND_DIR,
  DEPLOY_HOOK_RELEASES_DIR: RELEASES_DIR,
  DEPLOY_HOOK_CURRENT_LINK: CURRENT_LINK,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length) {
  console.error(`[deploy-hook] Refusing to start — not configured: ${missing.join(", ")}`);
  process.exit(1);
}

if (SECRET.length < 24) {
  console.error("[deploy-hook] Refusing to start — DEPLOY_HOOK_SECRET is too short to be one.");
  console.error("[deploy-hook] Generate one with: openssl rand -hex 32");
  process.exit(1);
}

/**
 * Linux only, and not incidentally: `cp -a`, `sh -c`, and the rename semantics
 * the next comment depends on are all POSIX. Windows returns EPERM for a rename
 * over an existing symlink, so the swap cannot be atomic there at all. Named
 * rather than silently half-working, because the failure lands after a
 * successful build and reads like a permissions problem.
 */
if (process.platform === "win32") {
  console.error("[deploy-hook] Refusing to start — this script is POSIX-only (see the note in source).");
  process.exit(1);
}

/**
 * The publish step is `rename` of a new symlink over `CURRENT_LINK`, which POSIX
 * defines as atomic *when the destination is itself a symlink or absent*. Renamed
 * onto a real directory it fails with EPERM — and the natural first-run state is
 * exactly that: a web root full of files from the deploy that was done by hand.
 *
 * Checked here rather than discovered in `build`, because there it surfaces after
 * a full vite build has run, in a log nobody is watching, on the one deploy where
 * the operator is most likely to assume the hook works.
 */
const validateCurrentLink = () => {
  let stat;
  try {
    stat = fs.lstatSync(CURRENT_LINK);
  } catch {
    return; // Absent is the good case — the first build creates it.
  }

  if (stat.isSymbolicLink()) return;

  console.error(`[deploy-hook] Refusing to start — ${CURRENT_LINK} exists and is not a symlink.`);
  console.error("[deploy-hook] This script publishes by swinging that path between release");
  console.error("[deploy-hook] directories, so it has to own it. Move the current site aside:");
  console.error("[deploy-hook]");
  console.error(`[deploy-hook]   mkdir -p ${RELEASES_DIR}`);
  console.error(`[deploy-hook]   mv ${CURRENT_LINK} ${path.join(RELEASES_DIR, "initial")}`);
  console.error(`[deploy-hook]   ln -s ${path.join(RELEASES_DIR, "initial")} ${CURRENT_LINK}`);
  process.exit(1);
};

validateCurrentLink();

const log = (message) => console.log(`[deploy-hook] ${new Date().toISOString()} ${message}`);

/* ── Authorisation ────────────────────────────────────────────────────────── */

const EXPECTED_PATH = `/deploy/${SECRET}`;

/**
 * Constant-time, and length-independent.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the secret's
 * length through the difference between a thrown 500 and a returned 404. Hashing
 * both sides first makes every comparison the same 32 bytes, so the only thing
 * an attacker learns from timing is that the server hashed two strings.
 */
const authorised = (candidate) => {
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(EXPECTED_PATH).digest();
  return crypto.timingSafeEqual(a, b);
};

/* ── The build ────────────────────────────────────────────────────────────── */

const run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: BUILD_TIMEOUT_MS,
        // A vite build over a large tree prints more than the 1 MB default and
        // would otherwise be killed for it, mid-build, reported as a crash.
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}\n${stderr || stdout}`));
          return;
        }
        resolve(stdout);
      }
    );
  });

/**
 * Build, publish, prune.
 *
 * The publish step is a symlink swap rather than a copy over the live directory,
 * because a copy is visible to readers while it is half done: nginx serves the
 * new index.html referencing hashed assets that have not landed yet, and every
 * visitor in that window gets a blank page. `rename` onto an existing symlink is
 * atomic on POSIX — the site is one release or the other, never between them.
 */
const build = async (reason) => {
  const startedAt = Date.now();
  log(`Build starting — ${reason}`);

  // Vite reads .env.production from this directory for `vite build`, which is
  // where VITE_API_BASE_URL and VITE_SITE_URL come from. The build calls the API
  // at VITE_API_BASE_URL for the published archive (build/blogFeed.js); if the
  // API is down it warns and ships the site without pre-rendered posts rather
  // than failing, so a build "succeeding" is not on its own proof the posts are
  // in it. That warning is in this log.
  //
  // Through `sh -c` rather than spawning npm directly, because npm is a shell
  // script on Linux and a `.cmd` shim on Windows, and `execFile` refuses the
  // latter outright (spawn EINVAL) since Node closed the .cmd argument-injection
  // hole. The usual patch for that is `shell: true`, which is worse: it
  // concatenates the *argument vector* into a command line, so anything
  // interpolated into it becomes shell syntax. Here the command is a constant —
  // no value from the request reaches it — so a shell adds a process and no
  // attack surface.
  await run("sh", ["-c", "npm run build"], FRONTEND_DIR);

  const dist = path.join(FRONTEND_DIR, "dist");
  if (!fs.existsSync(dist)) {
    throw new Error(`The build reported success but wrote no ${dist}.`);
  }

  await fsp.mkdir(RELEASES_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = path.join(RELEASES_DIR, `.${stamp}.incoming`);
  const release = path.join(RELEASES_DIR, stamp);

  // cp rather than rename: the checkout and the web root are routinely on
  // different mounts, and rename cannot cross one. Copying into a dot-prefixed
  // staging name first means a copy interrupted by a reboot leaves obvious
  // rubbish rather than a release directory that looks complete and is not.
  await run("cp", ["-a", dist, staging]);
  await fsp.rename(staging, release);

  // The temporary link must be in the same directory as the real one for the
  // rename to stay on one filesystem, and therefore atomic.
  const pending = path.join(path.dirname(CURRENT_LINK), `.current.${stamp}`);
  await fsp.symlink(release, pending);
  await fsp.rename(pending, CURRENT_LINK);

  log(`Published ${release} in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  await prune();
};

const prune = async () => {
  const entries = await fsp.readdir(RELEASES_DIR);
  const live = path.basename(await fsp.realpath(CURRENT_LINK));

  const stale = entries
    .filter((name) => !name.startsWith("."))
    .sort()
    .reverse()
    .slice(KEEP_RELEASES)
    // Belt and braces: the live release is the newest and so never in this
    // slice, but deleting the directory nginx is serving is unrecoverable enough
    // to be worth one comparison.
    .filter((name) => name !== live);

  for (const name of stale) {
    await fsp.rm(path.join(RELEASES_DIR, name), { recursive: true, force: true });
    log(`Pruned ${name}`);
  }
};

/* ── Coalescing ───────────────────────────────────────────────────────────── */

/**
 * deployHookService deliberately does not debounce — it says so, and it is right
 * to: on a managed host the redundant builds are the host's problem and it
 * cancels them. Here they are this box's problem, and three concurrent vite
 * builds on a small VPS is an out-of-memory kill that takes the API with it.
 *
 * So the coalescing a managed host would have done lives here instead. Requests
 * arriving during a build collapse into exactly one follow-up build, which is the
 * correct count: the posts published while the last build ran are all in the
 * database now, and one build picks up every one of them.
 */
let building = false;
let queued = null;

const requestBuild = (reason) => {
  if (building) {
    queued = reason;
    log(`Build already running — queued: ${reason}`);
    return "queued";
  }

  building = true;

  build(reason)
    .catch((error) => {
      // Swallowed on purpose: the previous release is still linked and still
      // serving, so a failed build is a site that is out of date, not a site
      // that is down. Crashing the hook would turn it into one that is also
      // unable to recover on the next publish.
      log(`Build FAILED — ${reason}\n${error.message}`);
    })
    .finally(() => {
      building = false;
      if (queued) {
        const next = queued;
        queued = null;
        requestBuild(next);
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
      if (typeof parsed.trigger_title === "string") reason = parsed.trigger_title;
    } catch {
      // deployHookService always sends JSON; a curl by hand may not. The reason
      // is a log line, so a missing one is not a failure.
    }

    const outcome = requestBuild(reason);

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
  log(`Set BLOG_DEPLOY_HOOK_URL=http://127.0.0.1:${PORT}/deploy/<DEPLOY_HOOK_SECRET> in the API's env.`);
});

// PM2 sends SIGINT on restart. Finishing the in-flight build is not worth
// engineering around — it is idempotent and the next publish triggers another —
// but refusing new connections while it drains keeps the shutdown quiet.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`${signal} — closing.`);
    server.close(() => process.exit(0));
  });
}
