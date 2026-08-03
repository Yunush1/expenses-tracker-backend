const express = require("express");

const groupController = require("../controllers/groupController");
const balanceController = require("../controllers/balanceController");
const activityController = require("../controllers/activityController");
const memberRoutes = require("./memberRoutes");
const expenseRoutes = require("./expenseRoutes");
const settlementRoutes = require("./settlementRoutes");

const validate = require("../middlewares/validate");
const {
  createGroupLimiter,
  writeLimiter,
  codeLookupLimiter,
} = require("../middlewares/rateLimiter");
const {
  loadGroup,
  resolveMember,
  requireCreator,
  requireActiveGroup,
} = require("../middlewares/groupAccess");

const {
  createGroupSchema,
  updateGroupSchema,
  lookupQuerySchema,
} = require("../validators/groupValidators");
const { listActivitiesQuery } = require("../validators/activityValidators");

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

/* ------------------------- Derived read models --------------------------- */

router.get("/:inviteCode/balances", balanceController.getBalances);

router.get(
  "/:inviteCode/activities",
  validate(listActivitiesQuery, "query"),
  activityController.listActivities
);

/* ---------------------------- Sub-resources ------------------------------ */

router.use("/:inviteCode/members", memberRoutes);
router.use("/:inviteCode/expenses", expenseRoutes);
router.use("/:inviteCode/settlements", settlementRoutes);

module.exports = router;
