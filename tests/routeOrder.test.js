const test = require("node:test");
const assert = require("node:assert/strict");

const expenseRoutes = require("../src/routes/expenseRoutes");
const memberRoutes = require("../src/routes/memberRoutes");
const groupRoutes = require("../src/routes/groupRoutes");

/**
 * Express matches routes in declaration order, so a literal path declared after a
 * parameterised sibling is silently swallowed: `POST /expenses/batch` becomes an
 * expense whose id is "batch", and fails as a validation error that says nothing
 * about routing.
 *
 * This has been an easy mistake to make three times over — /batch, /link,
 * /link-code, /lookup — so it is asserted rather than remembered.
 */

/** [{ method, path }] in declaration order, for a router's own layers. */
const routesOf = (router) =>
  router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({
        method: method.toUpperCase(),
        path: layer.route.path,
      }))
    );

const indexOf = (routes, method, path) =>
  routes.findIndex((route) => route.method === method && route.path === path);

const assertBefore = (routes, literal, parameterised, method = "POST") => {
  const literalAt = indexOf(routes, method, literal);
  const paramAt = indexOf(routes, method, parameterised);

  assert.notEqual(literalAt, -1, `${method} ${literal} is not registered`);

  // A parameterised sibling that does not exist cannot shadow anything.
  if (paramAt === -1) return;

  assert.ok(
    literalAt < paramAt,
    `${method} ${literal} is declared after ${parameterised} and will never match`
  );
};

test("expense batch route is not swallowed by /:expenseId", () => {
  const routes = routesOf(expenseRoutes);

  assertBefore(routes, "/batch", "/:expenseId");
  assert.notEqual(indexOf(routes, "POST", "/batch"), -1);
});

test("device link routes are not swallowed by /:memberId", () => {
  const routes = routesOf(memberRoutes);

  assertBefore(routes, "/link", "/:memberId");
  assertBefore(routes, "/link-code", "/:memberId");
  assertBefore(routes, "/join", "/:memberId");
  assertBefore(routes, "/claim", "/:memberId");
});

test("the merge route is registered under a member id", () => {
  const routes = routesOf(memberRoutes);
  assert.notEqual(indexOf(routes, "POST", "/:memberId/merge"), -1);
});

test("join-code lookup is declared before the group mount that would capture it", () => {
  const routes = routesOf(groupRoutes);
  const lookupAt = indexOf(routes, "GET", "/lookup");

  assert.notEqual(lookupAt, -1, "GET /lookup is not registered");

  // The ":inviteCode" routes are mounted via router.use and via literal GETs; the
  // lookup must precede every one of them.
  const firstParam = routes.findIndex((route) => route.path.startsWith("/:inviteCode"));

  if (firstParam !== -1) {
    assert.ok(lookupAt < firstParam, "GET /lookup would be read as an invite code");
  }
});

test("every literal segment precedes a parameterised sibling at the same depth", () => {
  // The general form of the rule, so a future route is caught without a new test.
  for (const [name, router] of [
    ["expenses", expenseRoutes],
    ["members", memberRoutes],
    ["groups", groupRoutes],
  ]) {
    const routes = routesOf(router);

    routes.forEach((route, index) => {
      const [, firstSegment = ""] = route.path.split("/");
      if (firstSegment.startsWith(":") || firstSegment === "") return;

      const shadowedBy = routes
        .slice(0, index)
        .find(
          (earlier) =>
            earlier.method === route.method &&
            earlier.path.split("/")[1]?.startsWith(":") &&
            earlier.path.split("/").length === route.path.split("/").length
        );

      assert.equal(
        shadowedBy,
        undefined,
        `${name}: ${route.method} ${route.path} is shadowed by ${shadowedBy?.path}`
      );
    });
  }
});
