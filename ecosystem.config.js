/**
 * PM2 process definition for the VPS (docs/02-HLD.md §10).
 *
 * ## Why this exists rather than `pm2 start npm -- start`
 *
 * The `start` script is `cross-env NODE_ENV=production node server.js`, and
 * `cross-env` is a devDependency. A production install is `npm ci --omit=dev`,
 * which does not install it — so running the npm script on the server fails on
 * a missing binary. cross-env earns its place locally, where the developers are
 * on Windows and `NODE_ENV=x cmd` is not valid there; on the Linux box it is
 * solving a problem that does not exist.
 *
 * Declaring the variable here instead means PM2 runs `server.js` directly, with
 * no shim in between and nothing from devDependencies on the path.
 */
module.exports = {
  apps: [
    {
      name: "splitly-api",
      script: "server.js",

      /**
       * One process, deliberately.
       *
       * The cron jobs are safe to run twice — both document an idempotency key
       * or a database claim that makes concurrent ticks produce one outcome —
       * so they are not the constraint. Socket.IO is. A client that opens with
       * HTTP long-polling makes several requests before it upgrades, and every
       * one of them has to reach the process holding that session; without
       * sticky routing at the proxy a second instance answers "session
       * unknown" and the connection dies in a retry loop.
       *
       * Raising this therefore means configuring ip_hash (nginx) or an equally
       * sticky rule *first*. The Redis adapter already in place handles the
       * other half — broadcasts spanning instances — but it cannot make a
       * handshake land on the right one.
       */
      instances: 1,
      exec_mode: "fork",

      env: {
        NODE_ENV: "production",
      },

      // The remaining configuration is read from .env.production on the server.
      // It is gitignored and deliberately not managed by CI: MONGO_URI, the
      // Firebase key and the SMTP password have no business in a repository or
      // in a workflow log.

      // A leak restarts the process instead of exhausting the box. Sized well
      // above steady state so it is a backstop, not a routine event.
      max_memory_restart: "512M",

      // A process that dies instantly and repeatedly is usually misconfigured,
      // not unlucky. Backing off keeps the logs readable and stops a crash loop
      // from pinning a core.
      exp_backoff_restart_delay: 100,

      // Winston already writes structured logs; these capture whatever escapes
      // it — a stack trace on boot, a native module's stderr.
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
