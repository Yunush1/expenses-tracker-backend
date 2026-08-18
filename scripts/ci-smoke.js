/**
 * Boots the real server and asks it whether it is alive.
 *
 *   node scripts/ci-smoke.js
 *
 * ## Why this exists next to `npm test`
 *
 * The unit tests never load `src/app.js`. They exercise the split maths, the
 * settlement optimiser and the entitlement policy as plain modules, which is
 * exactly what makes them fast and dependency-free — and exactly why they
 * cannot see the failures that happen on the way up: a require that no longer
 * resolves, a config key read at module load, a route registered on a path
 * pattern Express 5 rejects, a middleware that throws while being mounted.
 *
 * Every one of those ships a green build and a server that will not start.
 * This closes that gap with the cheapest possible check: start the process the
 * same way production does, wait for `GET /` to answer 200, stop it.
 *
 * ## Why it shells out instead of requiring the app
 *
 * `require("../src/app")` would prove the module loads, but not that the
 * process reaches a listening state — `server.js` awaits the database, settles
 * Redis, initialises Firebase and mail, and starts two cron jobs before it
 * opens the port. Those are where boot actually hangs, so the child process is
 * the honest test. It also means a `process.exit(1)` from config validation is
 * observed as a failure rather than killing the test runner itself.
 *
 * Exits 0 when the server answered, 1 otherwise — with the child's own stdout
 * and stderr already forwarded, because the log line before the failure is
 * always the one that explains it.
 */
const { spawn } = require("child_process");

const PORT = process.env.PORT || 5000;
const BOOT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves true once `GET /` returns 200 with the documented body. */
const isHealthy = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    if (res.status !== 200) return false;
    const body = await res.json();
    return body?.status === "success";
  } catch {
    // Connection refused while the port is still closed — expected, keep polling.
    return false;
  }
};

const main = async () => {
  console.log(`[smoke] starting server.js on port ${PORT}`);

  const server = spawn(process.execPath, ["server.js"], {
    stdio: "inherit",
    env: process.env,
  });

  let exited = null;
  server.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let healthy = false;

  while (Date.now() < deadline) {
    if (exited) {
      console.error(
        `[smoke] FAIL  server exited before it listened (code ${exited.code}, signal ${exited.signal})`
      );
      process.exit(1);
    }

    if (await isHealthy()) {
      healthy = true;
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (!healthy) {
    console.error(`[smoke] FAIL  no 200 from GET / within ${BOOT_TIMEOUT_MS / 1000}s`);
    server.kill("SIGKILL");
    process.exit(1);
  }

  console.log("[smoke] PASS  server booted and answered GET /");

  // SIGTERM so the shutdown path in server.js runs too — a hang here is itself
  // worth knowing about, hence the SIGKILL backstop rather than an open wait.
  server.kill("SIGTERM");
  const stopBy = Date.now() + 10_000;
  while (!exited && Date.now() < stopBy) await sleep(POLL_INTERVAL_MS);
  if (!exited) server.kill("SIGKILL");

  process.exit(0);
};

main().catch((err) => {
  console.error("[smoke] FAIL  unexpected error", err);
  process.exit(1);
});
