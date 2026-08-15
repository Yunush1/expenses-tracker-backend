const express = require("express");
const expenseController = require("../controllers/expenseController");
const validate = require("../middlewares/validate");
const { writeLimiter, scanLimiter } = require("../middlewares/rateLimiter");
const { requireMember, requireActiveGroup } = require("../middlewares/groupAccess");
const {
  createExpenseSchema,
  createExpenseBatchSchema,
  updateExpenseSchema,
  listExpensesQuery,
} = require("../validators/expenseValidators");
const { scanReceiptSchema } = require("../validators/receiptValidators");

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

/**
 * A photograph of a receipt → line items to confirm
 * (docs/10-AI-ASSISTANT.md §4.2, docs/22-MONETIZATION.md §14 step 7).
 *
 * Also before "/:expenseId", for the same reason as /batch.
 *
 * **Writes nothing.** It returns a draft that the person corrects and submits
 * through `/batch` above — so a model misreading crumpled thermal paper produces a
 * visible, editable mistake rather than a silent one in the ledger.
 *
 * `requireMember`, not `requireAuth`, and that asymmetry against every other AI
 * endpoint is deliberate: the cost control here is the *group's* metered scan
 * allowance, claimed atomically in receiptService, so no signup has to appear in
 * front of somebody photographing the groceries (docs/22 §1.1).
 *
 * `scanLimiter` sits on top of the allowance rather than instead of it. The
 * allowance bounds the month's spend; this bounds the burst, and one uploading
 * browser should not be able to occupy the provider connection pool.
 */
router.post(
  "/scan-receipt",
  scanLimiter,
  requireActiveGroup,
  requireMember,
  validate(scanReceiptSchema),
  expenseController.scanReceipt
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
