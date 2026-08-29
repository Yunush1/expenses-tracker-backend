/**
 * Who shares a rate-limit bucket.
 *
 * ## The report this comes from
 *
 * Ten friends on one Wi-Fi kept seeing failures on a group that was working.
 * Every limiter was keyed on IP, so they were **one** caller as far as the API
 * was concerned: 300 requests per 15 minutes between them, which a group page and
 * a few refetches will spend. The client then rendered any first-load error as
 * "Group not found", so a working link looked like a deleted group.
 *
 * The generous limiters are now keyed on `X-Device-Id`. These tests pin the three
 * things that has to mean, because two of them are silent when wrong:
 *
 *  1. Two browsers behind one IP get **separate** budgets.
 *  2. A caller with no device header still gets counted, by IP — otherwise the
 *     limiter would be trivially disabled by omitting a header.
 *  3. `codeLookupLimiter` stays on IP. It is the whole defence on a ~37-bit join
 *     code (docs/02-HLD.md §3.4), and a client-supplied key would let an attacker
 *     rotate a header and enumerate freely.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/splitly-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");

const app = require("../src/app");

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/**
 * A route that matches nothing, so this exercises the limiter without needing a
 * database. The limiters run before routing; the 404 is beside the point.
 */
const hit = (port, deviceId) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/__limiter_probe",
        method: "GET",
        headers: deviceId ? { "X-Device-Id": deviceId } : {},
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            remaining: Number(response.headers["ratelimit-remaining"]),
          })
        );
      }
    );
    request.on("error", reject);
    request.end();
  });

test("two browsers behind one IP do not share a budget", async (t) => {
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => server.close());

  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();

  await hit(port, alice);
  await hit(port, alice);
  const third = await hit(port, alice);

  const first = await hit(port, bob);

  assert.ok(
    Number.isFinite(third.remaining) && Number.isFinite(first.remaining),
    "the limiter should be sending standard RateLimit headers"
  );

  /**
   * The assertion that matters. Sharing a bucket would leave Bob with whatever
   * Alice had left; his own key means he starts fresh.
   */
  assert.ok(
    first.remaining > third.remaining,
    `Bob should have more budget than Alice after her three requests — got Bob ${first.remaining}, Alice ${third.remaining}`
  );
});

test("a caller with no device header is still counted", async (t) => {
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => server.close());

  const one = await hit(port, null);
  const two = await hit(port, null);

  /**
   * Falling back to the IP is what stops the limiter being switched off by
   * leaving a header out. Both requests land on the same `i:` key, so the
   * remaining count has to move.
   */
  assert.ok(
    two.remaining < one.remaining,
    `anonymous requests must share an IP bucket — got ${one.remaining} then ${two.remaining}`
  );
});

test("the join-code limiter is not keyed on anything the client controls", () => {
  /**
   * Checked by reading the module rather than by exhausting a 10-request limit
   * over HTTP: the point is *which key it uses*, and that is a property of the
   * source. A device-keyed code lookup would be defeated by rotating a header,
   * which is exactly the attack the limit exists to stop.
   */
  const source = require("node:fs").readFileSync(
    require.resolve("../src/middlewares/rateLimiter"),
    "utf8"
  );

  const codeLookup = source.slice(source.indexOf("const codeLookupLimiter"));
  const definition = codeLookup.slice(0, codeLookup.indexOf(");"));

  assert.ok(
    !definition.includes("byDeviceThenIp"),
    "codeLookupLimiter must stay IP-keyed — a client-supplied key defeats it"
  );
});
