const express = require("express");
const recurringExpenseController = require("../controllers/recurringExpenseController");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const { requireMember, requireActiveGroup } = require("../middlewares/groupAccess");
const {
  createRecurringSchema,
  updateRecurringSchema,
} = require("../validators/recurringExpenseValidators");

const router = express.Router({ mergeParams: true });

/**
 * Reading the list is open to anyone holding the link, like the expense list it
 * describes. Writing needs a member and an active group, like every other write.
 *
 * There is no `requireFeature` guard on the create route, and that is deliberate:
 * this is a **capacity** limit rather than a switch, so the check is "how many does
 * this group already have" — a count the service has to take anyway. The guard
 * would answer "may they at all", which is a different and weaker question.
 */
router.get("/", recurringExpenseController.list);

router.post(
  "/",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(createRecurringSchema),
  recurringExpenseController.create
);

router.patch(
  "/:templateId",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(updateRecurringSchema),
  recurringExpenseController.update
);

router.delete(
  "/:templateId",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  recurringExpenseController.remove
);

module.exports = router;
