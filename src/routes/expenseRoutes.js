const express = require("express");
const expenseController = require("../controllers/expenseController");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const { requireMember, requireActiveGroup } = require("../middlewares/groupAccess");
const {
  createExpenseSchema,
  createExpenseBatchSchema,
  updateExpenseSchema,
  listExpensesQuery,
} = require("../validators/expenseValidators");

const router = express.Router({ mergeParams: true });

router.get("/", validate(listExpensesQuery, "query"), expenseController.listExpenses);
router.get("/:expenseId", expenseController.getExpense);

router.post(
  "/",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(createExpenseSchema),
  expenseController.createExpense
);

// Declared before "/:expenseId" so the literal path is not captured as an id.
router.post(
  "/batch",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(createExpenseBatchSchema),
  expenseController.createExpenseBatch
);

router.patch(
  "/:expenseId",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(updateExpenseSchema),
  expenseController.updateExpense
);

router.delete(
  "/:expenseId",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  expenseController.deleteExpense
);

module.exports = router;
