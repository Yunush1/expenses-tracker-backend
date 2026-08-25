/**
 * The response headers on served upload files.
 *
 * ## The bug this exists to stop coming back
 *
 * `app.use(helmet())` sets `Cross-Origin-Resource-Policy: same-origin` by
 * default, and the frontend is not on this origin — splitly.shop against
 * api.splitly.shop in production, :5173 against :5000 in development. That header
 * told every browser to refuse these bytes to an `<img>` on the site that
 * uploaded them, so blog covers and receipt photos silently failed to render.
 *
 * It is worth knowing how the symptom presents, because it sends people looking
 * in the wrong place: **the URL opens perfectly in a new tab**. CORP does not
 * apply to a top-level navigation, only to an embed, so the file looks fine
 * whenever you check it by hand and is broken everywhere it is actually used.
 *
 * The mounts now set `cross-origin` explicitly. These tests pin that, and pin the
 * other half of it too: the JSON API must keep helmet's strict default, because
 * relaxing it globally would have been the easy fix and the wrong one.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
// Config refuses to load without it. Nothing in this file connects to anything —
// `src/app.js` builds the Express app and exports it; the connection is made by
// server.js, which is not loaded here.
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/splitly-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const app = require("../src/app");
const blogStorage = require("../src/utils/blogStorage");

/** A one-pixel GIF. Small enough to inline, real enough for express.static. */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const NAME = "corp-header-probe.gif";

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const head = (port, urlPath) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "GET" },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
      }
    );
    request.on("error", reject);
    request.end();
  });

test("upload mounts allow cross-origin embedding; the API does not", async (t) => {
  const dir = blogStorage.storageDir();
  const file = path.join(dir, NAME);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, PIXEL);

  const server = http.createServer(app);
  const port = await listen(server);

  t.after(() => {
    server.close();
    fs.rmSync(file, { force: true });
  });

  const image = await head(port, `${blogStorage.URL_PREFIX}/${NAME}`);

  assert.equal(image.status, 200, "the probe file should be served");
  assert.equal(
    image.headers["cross-origin-resource-policy"],
    "cross-origin",
    "a blog image that cannot be embedded cross-origin is a blog image that never renders"
  );
  // The other header this mount is responsible for. A browser that decides an
  // uploaded file is a document is the classic stored-XSS route.
  assert.equal(image.headers["x-content-type-options"], "nosniff");
  // Published on purpose: these are what a search result and a shared card show.
  assert.equal(image.headers["x-robots-tag"], "all");

  /**
   * The JSON API keeps helmet's default.
   *
   * Setting `crossOriginResourcePolicy: false` on helmet itself would have fixed
   * the images in one line and quietly relaxed every other response with them.
   * The fix belongs on the files that are meant to be embedded, and nowhere else.
   */
  const api = await head(port, "/api/definitely-not-a-route");

  assert.equal(api.status, 404, "expected the API's 404 handler, not a static file");
  assert.equal(
    api.headers["cross-origin-resource-policy"],
    "same-origin",
    "the API is not an embeddable resource and should not advertise itself as one"
  );
  assert.equal(api.headers["x-robots-tag"], "noindex, nofollow");
});
