/**
 * What a caller gets back when they send something too big.
 *
 * ## The report this came from
 *
 * A ~2 MB cover image failed to upload with `413 Request Entity Too Large`, and
 * the response had no JSON in it at all. It was nginx, not Node: the reverse
 * proxy's `client_max_body_size` defaults to 1 MB, so the request was refused
 * before Express saw a byte of it (see `deploy/nginx.conf`).
 *
 * Raising that limit exposed the second half of the problem, which is what these
 * tests pin. Express *does* have limits of its own, deliberately, and until now
 * every one of them surfaced as a 500 and "Something went wrong" — because
 * `error.middleware.js` treats anything that is not an `ApiError` as an
 * unexpected fault. The one failure whose cause is completely knowable, and whose
 * fix is entirely in the caller's hands, was being reported as a server crash.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/splitly-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const app = require("../src/app");
const blogStorage = require("../src/utils/blogStorage");
const config = require("../src/config/env");
const { ERROR_CODES } = require("../src/constants");

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const post = (port, path, body) =>
  new Promise((resolve, reject) => {
    const payload = Buffer.from(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": payload.length },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, text }));
      }
    );
    request.on("error", reject);
    request.end(payload);
  });

test("an oversized body is a 413 with a readable envelope, not a 500", async (t) => {
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => server.close());

  // Comfortably past the global 64 kb parser in app.js, and nowhere near the
  // 10 mb the blog admin routes are given.
  const tooBig = JSON.stringify({ filler: "x".repeat(200_000) });
  const response = await post(port, "/api/groups", tooBig);

  assert.equal(response.status, 413, "body-parser's refusal must not become a 500");

  const body = JSON.parse(response.text);
  assert.equal(body.success, false);
  assert.equal(
    body.code,
    ERROR_CODES.PAYLOAD_TOO_LARGE,
    "the client needs a code it can branch on to say 'that file is too big'"
  );
  assert.match(body.message, /too large/i);
});

test("a body inside the limit reaches the route", async (t) => {
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => server.close());

  /**
   * The point is only that the parser did not reject it — whatever the route
   * then decides (a validation error, an auth error) is a different subject.
   * Anything but 413 proves the request got past the limit.
   */
  const response = await post(port, "/api/groups", JSON.stringify({ filler: "x".repeat(1000) }));

  assert.notEqual(response.status, 413);
});

test("an image over the configured limit is a 413, not a crash", async () => {
  const overBy = config.blog.maxImageBytes + 1024;
  // A valid data URL whose decoded payload is deliberately past the cap. The
  // size check runs on the decoded bytes, so this has to be sized after base64.
  const dataUrl = `data:image/png;base64,${Buffer.alloc(overBy, 0).toString("base64")}`;

  await assert.rejects(
    () => blogStorage.save(dataUrl),
    (error) => {
      assert.equal(error.statusCode, 413, "a plain Error here would surface as a 500");
      assert.equal(error.code, ERROR_CODES.PAYLOAD_TOO_LARGE);
      assert.match(error.message, /limit is/i, "the message has to name the limit");
      return true;
    }
  );
});

test("an unsupported image type is a 400 the author can read", async () => {
  await assert.rejects(
    () => blogStorage.save("data:image/bmp;base64,QUJD"),
    (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
});
