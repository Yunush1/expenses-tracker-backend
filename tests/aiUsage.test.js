const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * The spend meter and the gate in front of it.
 *
 * Two things here are worth pinning. The **gate** must fail closed — an
 * authorization check that defaults to "allowed" when misconfigured is the kind of
 * bug that is invisible until it matters. And the **costing** must keep "no price
 * configured" distinct from "free": a dashboard reporting a confident ₹0.00 spend
 * because nobody set a rate is worse than one reporting nothing, because it will be
 * believed.
 *
 * `config/env` is frozen at require time, so each costing case re-imports it with a
 * fresh module registry rather than trying to mutate it.
 */

/** Load aiUsageService with a given environment, isolated from other cases. */
const withEnv = (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, { MONGO_URI: "mongodb://localhost/test", ...env });

  for (const key of Object.keys(require.cache)) {
    if (key.includes("config") || key.includes("aiUsageService")) delete require.cache[key];
  }

  try {
    return fn(require("../src/services/ai/aiUsageService"));
  } finally {
    process.env = saved;
    for (const key of Object.keys(require.cache)) {
      if (key.includes("config") || key.includes("aiUsageService")) delete require.cache[key];
    }
  }
};

const loadRequireAdmin = (adminEmails) => {
  const saved = { ...process.env };
  process.env.MONGO_URI = "mongodb://localhost/test";
  process.env.ADMIN_EMAILS = adminEmails;

  for (const key of Object.keys(require.cache)) {
    if (key.includes("config") || key.includes("requireAdmin")) delete require.cache[key];
  }

  const middleware = require("../src/middlewares/requireAdmin");
  process.env = saved;
  return middleware;
};

/** Runs the middleware and reports whether it allowed the request through. */
const runGate = (middleware, req) => {
  let error = null;
  let allowed = false;
  middleware(req, {}, (err) => {
    if (err) error = err;
    else allowed = true;
  });
  return { allowed, status: error?.statusCode ?? null };
};

test("the admin gate fails closed when nothing is configured", () => {
  const gate = loadRequireAdmin("");
  const result = runGate(gate, { user: { email: "yunushkh9@gmail.com" } });

  assert.equal(result.allowed, false, "an empty allowlist must forbid everyone");
  assert.equal(result.status, 403);
});

test("the admin gate admits a configured operator", () => {
  const gate = loadRequireAdmin("yunushkh9@gmail.com");
  assert.equal(runGate(gate, { user: { email: "yunushkh9@gmail.com" } }).allowed, true);
});

test("the admin gate refuses everyone else", () => {
  const gate = loadRequireAdmin("yunushkh9@gmail.com");

  for (const email of ["someone@else.com", "", undefined]) {
    const result = runGate(gate, { user: { email } });
    assert.equal(result.allowed, false, `"${email}" must be refused`);
    assert.equal(result.status, 403);
  }

  // No identity at all — belt and braces behind requireAuth.
  assert.equal(runGate(gate, {}).allowed, false);
});

test("the admin gate is case and whitespace insensitive", () => {
  const gate = loadRequireAdmin(" YunusHKH9@Gmail.com , other@x.com ");

  assert.equal(runGate(gate, { user: { email: "yunushkh9@gmail.com" } }).allowed, true);
  assert.equal(runGate(gate, { user: { email: "OTHER@X.COM" } }).allowed, true);
  // The verified claim is accepted when the stored row has no email yet.
  assert.equal(runGate(gate, { firebaseClaims: { email: "yunushkh9@gmail.com" } }).allowed, true);
});

test("no configured rates reports no cost, not a free one", () => {
  withEnv({ AI_PRICE_PER_MTOK_IN: "0", AI_PRICE_PER_MTOK_OUT: "0" }, (usage) => {
    // A million tokens is unambiguously not free — null is the honest answer.
    assert.equal(usage.costOf({ promptTokens: 1_000_000, completionTokens: 1_000_000 }), null);
  });
});

test("cost is priced per million tokens, input and output separately", () => {
  withEnv({ AI_PRICE_PER_MTOK_IN: "0.60", AI_PRICE_PER_MTOK_OUT: "3.00" }, (usage) => {
    // Exactly one million of each: the answer is the two rates added.
    assert.equal(usage.costOf({ promptTokens: 1_000_000, completionTokens: 1_000_000 }), 3.6);

    // Half a million input only.
    assert.equal(usage.costOf({ promptTokens: 500_000, completionTokens: 0 }), 0.3);

    // Output is the expensive half — a meter that averaged the two would miss this.
    const inputHeavy = usage.costOf({ promptTokens: 100_000, completionTokens: 0 });
    const outputHeavy = usage.costOf({ promptTokens: 0, completionTokens: 100_000 });
    assert.ok(outputHeavy > inputHeavy, "output must cost more than input at these rates");
  });
});

test("one rate configured is still a rate", () => {
  // A provider that bills only for output, or a half-finished config.
  withEnv({ AI_PRICE_PER_MTOK_IN: "0", AI_PRICE_PER_MTOK_OUT: "3.00" }, (usage) => {
    assert.equal(usage.costOf({ promptTokens: 1_000_000, completionTokens: 0 }), 0);
    assert.equal(usage.costOf({ promptTokens: 0, completionTokens: 1_000_000 }), 3);
  });
});

test("empty usage costs nothing when rates exist", () => {
  withEnv({ AI_PRICE_PER_MTOK_IN: "0.60", AI_PRICE_PER_MTOK_OUT: "3.00" }, (usage) => {
    assert.equal(usage.costOf({}), 0);
    assert.equal(usage.costOf({ promptTokens: 0, completionTokens: 0 }), 0);
  });
});

test("day and month keys are UTC and lexically sortable", () => {
  withEnv({}, (usage) => {
    const day = usage.dayKey(new Date("2026-08-14T23:30:00Z"));
    const month = usage.monthKey(new Date("2026-08-14T23:30:00Z"));

    assert.equal(day, "2026-08-14");
    assert.equal(month, "2026-08");
    // The month summary is a prefix match on the day key, so this must hold.
    assert.ok(day.startsWith(month), "a day key must begin with its month key");

    // Sortable as strings, which is what the byDay series relies on.
    const days = ["2026-08-09", "2026-08-10", "2026-08-02"].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(days, ["2026-08-02", "2026-08-09", "2026-08-10"]);
  });
});
