const asyncHandler = require("../middlewares/asyncHandler");
const recurringExpenseService = require("../services/recurringExpenseService");
const { ok, created } = require("../utils/apiResponse");

/**
 * Recurring expense templates (docs/16-TODO.md §2.2).
 *
 * Every write returns the **whole list** rather than the one row it touched. That
 * is deliberate: which templates actually run depends on the group's plan and on
 * creation order, so adding or removing one can change whether a *different* one
 * is dormant. Returning a single row would leave the client to recompute that
 * rule, which is the sort of duplication that ends with the screen and the
 * scheduler disagreeing about what will happen.
 */

exports.list = asyncHandler(async (req, res) =>
  ok(res, await recurringExpenseService.listForGroup(req.group))
);

exports.create = asyncHandler(async (req, res) => {
  const data = await recurringExpenseService.create({
    group: req.group,
    actor: req.member,
    dto: req.body,
  });

  return created(res, data, "Recurring expense added");
});

exports.update = asyncHandler(async (req, res) => {
  const data = await recurringExpenseService.update({
    group: req.group,
    actor: req.member,
    templateId: req.params.templateId,
    dto: req.body,
  });

  return ok(res, data, "Recurring expense updated");
});

exports.remove = asyncHandler(async (req, res) => {
  const data = await recurringExpenseService.remove({
    group: req.group,
    templateId: req.params.templateId,
  });

  // Said in the message because it is the question somebody has while deleting.
  return ok(res, data, "Stopped. The expenses it already added are unchanged.");
});
