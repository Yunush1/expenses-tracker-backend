const asyncHandler = require("../middlewares/asyncHandler");
const expenseService = require("../services/expenseService");
const receiptService = require("../services/receiptService");
const { ok, created } = require("../utils/apiResponse");

exports.listExpenses = asyncHandler(async (req, res) => {
  // Passed straight through: every field is already validated and constrained to
  // a closed set, so enumerating them again here is a second place to forget one.
  const data = await expenseService.listExpenses(req.group, req.validatedQuery);
  return ok(res, data);
});

exports.listPeriods = asyncHandler(async (req, res) =>
  ok(res, await expenseService.listPeriods(req.group))
);

exports.getExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.getExpense(req.group, req.params.expenseId);
  return ok(res, { expense });
});

exports.createExpense = asyncHandler(async (req, res) => {
  const { expense, created: isNew } = await expenseService.createExpense({
    group: req.group,
    actor: req.member,
    dto: req.body,
  });

  // A replayed clientRequestId returns the original expense with 200.
  return isNew
    ? created(res, { expense }, "Expense added")
    : ok(res, { expense }, "Expense already recorded");
});

exports.createExpenseBatch = asyncHandler(async (req, res) => {
  const result = await expenseService.createExpenseBatch({
    group: req.group,
    actor: req.member,
    dto: req.body,
  });

  return created(res, result, `${result.created} item(s) added`);
});

/**
 * A photograph → line items to confirm (docs/10-AI-ASSISTANT.md §4.2).
 *
 * 200 even when the photo was not a receipt: the request succeeded, the model
 * answered, and `isReceipt: false` is that answer. A 4xx there would tell the
 * client something was wrong with its request when nothing was.
 */
exports.scanReceipt = asyncHandler(async (req, res) => {
  const data = await receiptService.scan({ group: req.group, image: req.body.image });

  return ok(
    res,
    data,
    data.isReceipt ? "Receipt read — check the lines before adding" : "That doesn't look like a receipt"
  );
});

exports.updateExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.updateExpense({
    group: req.group,
    actor: req.member,
    expenseId: req.params.expenseId,
    dto: req.body,
  });

  return ok(res, { expense }, "Expense updated");
});

exports.deleteExpense = asyncHandler(async (req, res) => {
  await expenseService.deleteExpense({
    group: req.group,
    actor: req.member,
    expenseId: req.params.expenseId,
  });

  return ok(res, null, "Expense deleted");
});
