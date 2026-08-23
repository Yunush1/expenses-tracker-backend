const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * "Taken" has to mean the same thing in two places.
 *
 * The unique index in `models/group.js` decides what the database will accept.
 * `groupRepository.existsByJoinCode` decides what the app *tells the user* it will
 * accept. When they disagreed, a code belonging to a deleted group read as free,
 * `resolveJoinCode` allowed it, and the insert then failed on the index — a bare
 * `E11000` that reached the client as "That record already exists", naming no
 * field, moments after the same code had been reported as not existing at all.
 *
 * Read from source rather than exercised against Mongo: the whole failure was a
 * *filter* that drifted, and the filter is visible in the text. A test needing a
 * live database would not run here and so would not have caught it.
 */

const read = (relative) => readFileSync(join(__dirname, "..", relative), "utf8");

test("the join code index covers every group, whatever its status", () => {
  const model = read("src/models/group.js");

  const index = /groupSchema\.index\(\s*\{\s*joinCode: 1\s*\},\s*\{([\s\S]*?)\}\s*\);/.exec(model);
  assert.ok(index, "the unique joinCode index is not where this test expects it");

  assert.match(index[1], /unique:\s*true/, "the joinCode index must stay unique");
  assert.match(index[1], /\$type:\s*"string"/, "it must remain partial on a string code");

  /**
   * If the index is ever narrowed by status, the reservation rule changes and
   * `existsByJoinCode` has to change with it — which is the drift this file
   * exists to catch. Fail loudly rather than let the two quietly diverge again.
   */
  assert.doesNotMatch(
    index[1],
    /status/,
    "the index now filters on status — existsByJoinCode must be updated to match"
  );
});

test("existsByJoinCode does not narrow by status", () => {
  const repo = read("src/repositories/groupRepository.js");

  const fn = /const existsByJoinCode = \(joinCode\) => \{([\s\S]*?)\n\};/.exec(repo);
  assert.ok(fn, "existsByJoinCode is not where this test expects it");

  assert.match(fn[1], /Group\.exists\(\{\s*joinCode\s*\}\)/, "it must query on the code alone");

  // The original bug, in one assertion: `status: ACTIVE` here made a deleted or
  // archived group's code look free while the index still held it.
  assert.doesNotMatch(
    fn[1],
    /GROUP_STATUS|status:/,
    "existsByJoinCode filters by status again — it must mirror the index, which does not"
  );
});

test("a null code is not treated as a code every group shares", () => {
  const repo = read("src/repositories/groupRepository.js");
  const fn = /const existsByJoinCode = \(joinCode\) => \{([\s\S]*?)\n\};/.exec(repo);

  // Without the guard, `Group.exists({ joinCode: null })` matches the first group
  // that has no join code — so every requested code reports as taken and group
  // creation fails for everyone.
  assert.match(fn[1], /if \(!joinCode\)/, "the null guard is missing");
});

test("deleting a group releases its join code but keeps its invite code", () => {
  const service = read("src/services/groupService.js");

  const fn = /const deleteGroup = async \(\{ group \}\) => \{([\s\S]*?)\n\};/.exec(service);
  assert.ok(fn, "deleteGroup is not where this test expects it");

  assert.match(fn[1], /joinCode:\s*null/, "deleteGroup must hand the short code back");
  assert.match(fn[1], /GROUP_STATUS\.DELETED/, "deleteGroup must still mark the row deleted");

  /**
   * The invite code is this row's identity: every route resolves the group by it,
   * including the ones that answer 410 Gone. Clearing it would turn "this group
   * was deleted" into a 404 that explains nothing.
   */
  assert.doesNotMatch(fn[1], /inviteCode/, "deleteGroup must not touch the invite code");
});

/* ------------------------------ Restoring ------------------------------- */

test("deleting remembers the code it released", () => {
  const service = read("src/services/groupService.js");
  const fn = /const deleteGroup = async \(\{ group \}\) => \{([\s\S]*?)\n\};/.exec(service);

  // Released so somebody can reuse ROOM405 today, remembered so a restore can
  // ask for it back. The two are only compatible because `releasedJoinCode` sits
  // outside the unique index.
  assert.match(fn[1], /releasedJoinCode/, "deleteGroup must remember the released code");
});

test("the released code is outside the unique index", () => {
  const model = read("src/models/group.js");

  // If it were ever indexed unique, remembering it would reserve it — which is
  // the bug this whole change exists to remove, reintroduced under a new name.
  assert.doesNotMatch(
    model,
    /index\(\s*\{\s*releasedJoinCode/,
    "releasedJoinCode must not be uniquely indexed, or deletion reserves the code again"
  );
});

test("restore re-claims the old code only when nothing else holds it", () => {
  const service = read("src/services/groupService.js");
  const fn = /const restoreGroup = async \(\{ group, actor \}\) => \{([\s\S]*?)\n\};/.exec(service);
  assert.ok(fn, "restoreGroup is not where this test expects it");

  assert.match(fn[1], /existsByJoinCode/, "restore must check the code is still free");
  assert.match(fn[1], /GROUP_STATUS\.ACTIVE/, "restore must set the group back to ACTIVE");
  assert.match(fn[1], /releasedJoinCode: null/, "restore must clear the memory once used");

  // A restore that took a code back off a live group would be the mirror of the
  // original bug: two groups, one code, the index deciding which survives.
  assert.match(fn[1], /!\(await groupRepository\.existsByJoinCode/, "the check must gate the re-claim");
});

test("restore is creator-only and mounted above the guard that would refuse it", () => {
  const routes = read("src/routes/groupRoutes.js");

  const restoreAt = routes.indexOf('"/:inviteCode/restore"');
  const guardAt = routes.indexOf('router.use("/:inviteCode", loadGroup, resolveMember)');

  assert.notEqual(restoreAt, -1, "the restore route is not registered");
  assert.notEqual(guardAt, -1, "the loadGroup mount moved — this test needs updating");

  /**
   * `loadGroup` answers 410 for a deleted group, so a restore route declared
   * after it can never run. This is the whole reason the route sits where it
   * does, and it is the kind of ordering that gets "tidied" later.
   */
  assert.ok(
    restoreAt < guardAt,
    "POST /:inviteCode/restore is declared after loadGroup and would always 410"
  );

  const block = routes.slice(restoreAt, restoreAt + 400);
  assert.match(block, /loadGroupIncludingDeleted/, "restore must use the deleted-aware loader");
  assert.match(block, /requireCreator/, "restore must be creator-only");
});

test("only the restore route may see a deleted group", () => {
  const routes = read("src/routes/groupRoutes.js");

  /**
   * One caller, deliberately. If this grows, deleted groups are leaking into
   * routes written on the assumption that they never arrive.
   *
   * Comments are stripped first: the guard is named in prose right above the
   * route, and counting that as a use makes the assertion fail for a reason that
   * has nothing to do with what it is checking.
   */
  const code = routes.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const uses = code.match(/loadGroupIncludingDeleted/g) || [];

  // One in the destructured import, one in the route chain.
  assert.equal(uses.length, 2, `loadGroupIncludingDeleted is used ${uses.length} times, expected 2`);
});

test("a deleted group tells its creator, and only its creator, that it can be restored", () => {
  const guard = read("src/middlewares/groupAccess.js");
  const block = /if \(group\.status === GROUP_STATUS\.DELETED\) \{([\s\S]*?)\n  \}/.exec(guard);
  assert.ok(block, "the deleted branch is not where this test expects it");

  assert.match(block[1], /canRestore/, "the 410 must carry canRestore so the client can offer it");
  assert.match(block[1], /member\?\.isCreator/, "canRestore must be gated on being the creator");
});
