const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://localhost/test";

const { normalizePath, classifySource, isBot, dayRange } = require("../src/utils/siteStats");

/* ------------------------------ normalizePath ----------------------------- */

test("capability paths never keep their code", () => {
  assert.equal(normalizePath("/g/GOA2026"), "/g/:code");
  assert.equal(normalizePath("/join/abc123?x=1"), "/join/:code");
  assert.equal(normalizePath("/sheet/s3cr3t"), "/sheet/:code");
  assert.equal(normalizePath("/s/xyz"), "/s/:code");
  assert.equal(normalizePath("/G/UPPER"), "/g/:code");
});

test("query string and hash are dropped, trailing slash folded", () => {
  assert.equal(normalizePath("/blog/?utm_source=x#top"), "/blog");
  assert.equal(normalizePath("/faq/"), "/faq");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("/?ref=abc"), "/");
});

test("ordinary site paths are kept", () => {
  assert.equal(normalizePath("/blog/split-groceries-with-flatmates"), "/blog/split-groceries-with-flatmates");
  assert.equal(normalizePath("/tools/settle-up-calculator"), "/tools/settle-up-calculator");
});

test("anything that is not a plausible route is filed as /other", () => {
  assert.equal(normalizePath("/<script>alert(1)</script>"), "/other");
  assert.equal(normalizePath(`/${"a".repeat(150)}`), "/other");
  assert.equal(normalizePath("/a/b/c/d/e/f"), "/other");
  assert.equal(normalizePath("/blog/../../etc"), "/other");
  assert.equal(normalizePath("/naïve"), "/other");
});

test("non-paths are dropped", () => {
  assert.equal(normalizePath("https://evil.example/"), null);
  assert.equal(normalizePath(""), null);
  assert.equal(normalizePath(42), null);
});

/* ----------------------------- classifySource ----------------------------- */

test("referrers fall into fixed buckets", () => {
  const site = ["splitly.shop"];
  assert.equal(classifySource("", site), "direct");
  assert.equal(classifySource("www.google.com", site), "search");
  assert.equal(classifySource("www.google.co.in", site), "search");
  assert.equal(classifySource("duckduckgo.com", site), "search");
  assert.equal(classifySource("l.facebook.com", site), "social");
  assert.equal(classifySource("t.co", site), "social");
  assert.equal(classifySource("chatgpt.com", site), "ai");
  assert.equal(classifySource("gemini.google.com", site), "ai");
  assert.equal(classifySource("someblog.in", site), "other");
});

test("navigation inside the site is not a source", () => {
  assert.equal(classifySource("splitly.shop", ["splitly.shop"]), null);
  assert.equal(classifySource("www.splitly.shop", ["splitly.shop"]), null);
});

/* ---------------------------------- isBot --------------------------------- */

test("crawlers and lab tools are not visitors", () => {
  assert.equal(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), true);
  assert.equal(isBot("Mozilla/5.0 ... Chrome-Lighthouse"), true);
  assert.equal(isBot("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0"), true);
  assert.equal(isBot(""), true);
  assert.equal(isBot(undefined), true);
  assert.equal(
    isBot("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"),
    false
  );
});

/* -------------------------------- dayRange -------------------------------- */

test("dayRange lists consecutive days ending today, across a month end", () => {
  assert.deepEqual(dayRange("2026-12-02", 4), ["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
  assert.deepEqual(dayRange("2026-11-27", 1), ["2026-11-27"]);
});

/* ------------------------------ recordVisit ------------------------------- */

test("recordVisit increments total, page and (on arrival) source in one bulk write", async () => {
  const SiteVisit = require("../src/models/siteVisit");
  const service = require("../src/services/siteStatsService");

  const calls = [];
  const original = SiteVisit.bulkWrite;
  SiteVisit.bulkWrite = async (ops, opts) => {
    calls.push({ ops, opts });
  };

  try {
    // 2026-11-26T20:00Z is already the 27th in India.
    const now = new Date("2026-11-26T20:00:00Z");

    await service.recordVisit({ path: "/g/SECRET1", ref: "www.google.com", firstToday: true, firstEver: true }, now);
    await service.recordVisit({ path: "/faq", ref: "www.google.com", firstToday: false, firstEver: false }, now);

    assert.equal(calls.length, 2);

    const first = calls[0].ops.map((op) => op.updateOne);
    assert.deepEqual(
      first.map((op) => op.filter),
      [
        { day: "2026-11-27", dim: "total", key: "all" },
        { day: "2026-11-27", dim: "path", key: "/g/:code" },
        { day: "2026-11-27", dim: "source", key: "search" },
      ]
    );
    assert.deepEqual(first[0].update, { $inc: { views: 1, visitors: 1, newVisitors: 1 } });
    assert.ok(first.every((op) => op.upsert === true));
    assert.equal(calls[0].opts.ordered, false);
    assert.ok(!JSON.stringify(calls).includes("SECRET1"), "an invite code reached the database");

    // A later page in the same visit: a view, but not a new visitor or a new source.
    const second = calls[1].ops.map((op) => op.updateOne);
    assert.equal(second.length, 2);
    assert.deepEqual(second[1].filter, { day: "2026-11-27", dim: "path", key: "/faq" });
    assert.deepEqual(second[1].update, { $inc: { views: 1, visitors: 0, newVisitors: 0 } });
  } finally {
    SiteVisit.bulkWrite = original;
  }
});

/* ------------------------------- routes ----------------------------------- */

test("the overview is behind requireAuth then requireAdmin; the beacon is not", () => {
  const router = require("../src/routes/statsRoutes");
  const requireAuth = require("../src/middlewares/requireAuth");
  const requireAdmin = require("../src/middlewares/requireAdmin");

  const route = (method, path) =>
    router.stack.find((layer) => layer.route && layer.route.path === path && layer.route.methods[method]).route;

  const overview = route("get", "/admin/overview").stack.map((layer) => layer.handle);
  assert.equal(overview[0], requireAuth);
  assert.equal(overview[1], requireAdmin);

  const visit = route("post", "/visit").stack.map((layer) => layer.handle);
  assert.ok(!visit.includes(requireAuth));
  assert.ok(!visit.includes(requireAdmin));
});

/* ------------------------------- overview --------------------------------- */

test("overview fills every day of the range and sums the windows", async () => {
  const SiteVisit = require("../src/models/siteVisit");
  const Group = require("../src/models/group");
  const Expense = require("../src/models/expense");
  const Member = require("../src/models/member");
  const User = require("../src/models/user");
  const Settlement = require("../src/models/settlement");
  const service = require("../src/services/siteStatsService");

  const stubs = [];
  const stub = (obj, name, fn) => {
    stubs.push([obj, name, obj[name]]);
    obj[name] = fn;
  };

  stub(SiteVisit, "find", () => ({
    lean: async () => [
      { day: "2026-11-25", views: 10, visitors: 4, newVisitors: 3 },
      { day: "2026-11-27", views: 6, visitors: 2, newVisitors: 1 },
    ],
  }));
  stub(SiteVisit, "aggregate", async (pipeline) =>
    pipeline[0].$match.dim === "path"
      ? [{ _id: "/", views: 12, visitors: 5, newVisitors: 4 }]
      : [{ _id: "search", views: 3, visitors: 3, newVisitors: 2 }]
  );
  stub(Group, "aggregate", async () => [{ _id: "2026-11-27", n: 2 }]);
  stub(Expense, "aggregate", async () => [{ _id: "2026-11-26", n: 5 }]);
  stub(Member, "aggregate", async () => []);
  stub(User, "aggregate", async () => [{ _id: "2026-11-27", n: 1 }]);
  stub(Settlement, "aggregate", async () => []);
  stub(Group, "countDocuments", async (filter) => (filter.lastActivityAt ? 3 : 40));
  stub(Expense, "countDocuments", async () => 500);
  stub(Member, "estimatedDocumentCount", async () => 120);
  stub(User, "estimatedDocumentCount", async () => 15);

  try {
    const data = await service.overview({ days: 3 }, new Date("2026-11-27T06:00:00Z"));

    assert.equal(data.from, "2026-11-25");
    assert.equal(data.to, "2026-11-27");
    assert.deepEqual(
      data.series.map((d) => [d.day, d.views, d.groups, d.expenses, d.signups]),
      [
        ["2026-11-25", 10, 0, 0, 0],
        ["2026-11-26", 0, 0, 5, 0],
        ["2026-11-27", 6, 2, 0, 1],
      ]
    );
    assert.equal(data.today.visitors, 2);
    assert.equal(data.range.views, 16);
    assert.equal(data.range.expenses, 5);
    assert.deepEqual(data.topPages[0], { key: "/", views: 12, visitors: 5, newVisitors: 4 });
    assert.equal(data.sources[0].key, "search");
    assert.deepEqual(data.allTime, { groups: 40, expenses: 500, members: 120, accounts: 15 });
    assert.deepEqual(data.activeGroups, { last7: 3, last30: 3 });
  } finally {
    for (const [obj, name, fn] of stubs.reverse()) obj[name] = fn;
  }
});
