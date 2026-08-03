const asyncHandler = require("../middlewares/asyncHandler");
const expenseService = require("../services/expenseService");
const { ok, created } = require("../utils/apiResponse");

exports.listExpenses = asyncHandler(async (req, res) => {
  const { cursor, limit, memberId } = req.validatedQuery;
  const data = await expenseService.listExpenses(req.group, { cursor, limit, memberId });
  return ok(res, data);
});

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
