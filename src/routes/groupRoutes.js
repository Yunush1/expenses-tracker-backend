const express = require("express");

const groupController = require("../controllers/groupController");
const entitlementController = require("../controllers/entitlementController");
const joinRequestController = require("../controllers/joinRequestController");
const balanceController = require("../controllers/balanceController");
// Mounted on the group router rather than the expense one: periods describe the
// group's timeline, and the expense router is scoped under /expenses.
const expenseController = require("../controllers/expenseController");
const activityController = require("../controllers/activityController");
const analyticsController = require("../controllers/analyticsController");
const exportController = require("../controllers/exportController");
const memberRoutes = require("./memberRoutes");
const expenseRoutes = require("./expenseRoutes");
const recurringExpenseRoutes = require("./recurringExpenseRoutes");
const settlementRoutes = require("./settlementRoutes");

const validate = require("../middlewares/validate");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const {
  createGroupLimiter,
  writeLimiter,
  codeLookupLimiter,
} = require("../middlewares/rateLimiter");
const {
  loadGroup,
  loadGroupIncludingDeleted,
  resolveMember,
  requireMember,
  requireCreator,
  requireActiveGroup,
} = require("../middlewares/groupAccess");

const {
  createGroupSchema,
  updateGroupSchema,
  lookupQuerySchema,
} = require("../validators/groupValidators");
const {
  createJoinRequestSchema,
  decideJoinRequestSchema,
} = require("../validators/joinRequestValidators");
const {
  grantEntitlementSchema,
  revokeEntitlementSchema,
} = require("../validators/entitlementValidators");
const { listActivitiesQuery } = require("../validators/activityValidators");
const { categoryBreakdownQuery, exportQuery } = require("../validators/analyticsValidators");
const { balancesQuery } = require("../validators/balanceValidators");

const router = express.Router();

/* ------------------------------- Group ---------------------------------- */

router.post("/", createGroupLimiter, validate(createGroupSchema), groupController.createGroup);

/**
 * Short code → invite code. Declared before the "/:inviteCode" mount so the literal
 * path wins, and carries the strictest limit in the API because it is the only route
 * that can be guessed at — see docs/02-HLD.md §3.4.
 */
router.get(
  "/lookup",
  codeLookupLimiter,
  validate(lookupQuerySchema, "query"),
  groupController.lookupByJoinCode
);

/**
 * Asking to be let in, and checking whether anybody has answered.
 *
 * Declared before the "/:inviteCode" mount, and deliberately outside it: the
 * person asking has no invite code — that is the entire point of the flow, since
 * withholding it is what makes a guessed short code worthless
 * (docs/13-JOIN-APPROVAL.md).
 *
 * `codeLookupLimiter` on the create route because it takes the same guessable
 * code the lookup does, and must be no cheaper to attack.
 */
router.post(
  "/join-requests",
  codeLookupLimiter,
  validate(createJoinRequestSchema),
  joinRequestController.createRequest
);
router.get("/join-requests/:requestId", joinRequestController.getStatus);
router.delete("/join-requests/:requestId", joinRequestController.cancel);

/**
 * Undo a delete — the one route that must see a deleted group.
 *
 * Declared **above** the `loadGroup` mount below, because that guard answers 410
 * for a deleted group and would refuse this before it ran. It brings its own
 * chain instead: `loadGroupIncludingDeleted` to see the row at all,
 * `resolveMember` to find who is asking — members survive a delete, so the
 * creator is still resolvable — and `requireCreator`, because only the person who
 * could delete it may put it back (docs/02-HLD.md §3.4).
 *
 * Not behind `requireActiveGroup`, for the obvious reason.
 */
router.post(
  "/:inviteCode/restore",
  writeLimiter,
  loadGroupIncludingDeleted,
  resolveMember,
  requireCreator,
  groupController.restoreGroup
);

// Everything below is scoped to one group. `loadGroup` + `resolveMember` run for
// every route: reads are open to anyone with the link, writes add their own guards.
router.use("/:inviteCode", loadGroup, resolveMember);

router.get("/:inviteCode/preview", groupController.getPreview);
router.get("/:inviteCode", groupController.getSummary);

router.patch(
  "/:inviteCode",
  writeLimiter,
  requireActiveGroup,
  requireCreator,
  validate(updateGroupSchema),
  groupController.updateGroup
);

router.post("/:inviteCode/archive", writeLimiter, requireCreator, groupController.archiveGroup);
router.delete("/:inviteCode", writeLimiter, requireCreator, groupController.deleteGroup);

/* ----------------------------- Entitlement ------------------------------- */

/**
 * Granting and ending a group's plan by hand (docs/22-MONETIZATION.md §14).
 *
 * The only account-gated routes on the group router, and the asymmetry is the
 * design rather than an oversight: reading a group needs no sign-in and never
 * will, while *giving* one a paid plan is an operator action and has to be
 * attributable. `requireAuth` establishes who is asking and `requireAdmin` decides
 * whether they may — the same pairing that gates the AI spend card, extended
 * rather than replaced by a role system nobody needs yet.
 *
 * There is no matching GET. A group's plan travels on its summary payload, which
 * every screen already loads; a second endpoint for the same booleans would be a
 * second thing to go stale.
 */
router.post(
  "/:inviteCode/entitlement",
  writeLimiter,
  requireAuth,
  requireAdmin,
  validate(grantEntitlementSchema),
  entitlementController.grant
);

router.delete(
  "/:inviteCode/entitlement",
  writeLimiter,
  requireAuth,
  requireAdmin,
  validate(revokeEntitlementSchema),
  entitlementController.revoke
);

/* ------------------------- Derived read models --------------------------- */

router.get(
  "/:inviteCode/balances",
  validate(balancesQuery, "query"),
  balanceController.getBalances
);

/**
 * Which months and years this group has spending in — so one group can run for
 * years instead of one per month (docs/14-PERIODS.md).
 */
router.get("/:inviteCode/periods", expenseController.listPeriods);

router.get(
  "/:inviteCode/activities",
  validate(listActivitiesQuery, "query"),
  activityController.listActivities
);

/**
 * Where the money went, by category (docs/16-TODO.md §2.3).
 *
 * A plain group read like the ones above it — no `requireMember`, because anyone
 * holding the link can already see every expense this aggregates. What the group's
 * plan decides is how far *back* it reaches, and that check lives in the service
 * where it can run before the query rather than after it.
 */
router.get(
  "/:inviteCode/analytics/categories",
  validate(categoryBreakdownQuery, "query"),
  analyticsController.getCategoryBreakdown
);

/**
 * The group's record as a CSV file (docs/22-MONETIZATION.md §14 step 3).
 *
 * `requireMember` rather than an open read, unlike the analytics beside it, and
 * the asymmetry is deliberate: this is a **metered** feature, so an anonymous
 * visitor holding a link could otherwise drain a group's monthly allowance from a
 * loop. Everything in the file is already visible to anyone with the link — the
 * guard is protecting the allowance, not the data.
 *
 * `writeLimiter` for the same reason, though the allowance is the real bound.
 */
router.get(
  "/:inviteCode/export",
  writeLimiter,
  requireMember,
  validate(exportQuery, "query"),
  exportController.exportCsv
);

/**
 * Answering a request. Behind `requireMember`, because letting someone into a
 * group is a decision only the people already in it can make — and because the
 * push notification's Accept button posts here with the device id it was
 * delivered to, which is checked exactly like a tap inside the app.
 */
router.get(
  "/:inviteCode/join-requests",
  requireMember,
  joinRequestController.listPending
);

router.post(
  "/:inviteCode/join-requests/:requestId",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(decideJoinRequestSchema),
  joinRequestController.decide
);

/**
 * Recovering an identity after clearing browser storage. Creates a request that a
 * member answers — never a claim this browser can complete on its own.
 */
router.post(
  "/:inviteCode/members/:memberId/claim-request",
  writeLimiter,
  requireActiveGroup,
  joinRequestController.claimMember
);

/* ---------------------------- Sub-resources ------------------------------ */

router.use("/:inviteCode/members", memberRoutes);
router.use("/:inviteCode/expenses", expenseRoutes);
/**
 * Templates that produce expenses on a schedule (docs/16-TODO.md §2.2).
 *
 * A sibling of `/expenses` rather than a path under it, because a template is not
 * an expense: it has no shares, no date on which money moved, and deleting one
 * must never be confused with deleting the rows it created.
 */
router.use("/:inviteCode/recurring", recurringExpenseRoutes);
router.use("/:inviteCode/settlements", settlementRoutes);

module.exports = router;
