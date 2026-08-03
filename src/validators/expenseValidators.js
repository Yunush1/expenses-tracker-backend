const { z } = require("zod");
const { objectId, amount, trimmedString, clientRequestId, paginationQuery } = require("./common");
const { LIMITS, SPLIT_TYPES } = require("../constants");

/** Guards against a mistyped year landing an expense in 2036. */
const expenseDate = z.coerce
  .date()
  .refine((date) => date.getTime() <= Date.now() + 24 * 60 * 60 * 1000, {
    message: "Expense date cannot be in the future",
  })
  .optional();

const participantIds = z
  .array(objectId)
  .min(1, "Select at least one participant")
  .max(LIMITS.MAX_PARTICIPANTS, `At most ${LIMITS.MAX_PARTICIPANTS} participants`);

const createExpenseSchema = z.object({
  description: trimmedString(LIMITS.EXPENSE_DESC_MAX, "Description"),
  amount,
  paidBy: objectId,
  participantIds,
  splitType: z.nativeEnum(SPLIT_TYPES).optional().default(SPLIT_TYPES.EQUAL),
  expenseDate,
  notes: z.string().trim().max(LIMITS.EXPENSE_NOTES_MAX).optional().default(""),
  clientRequestId,
});

const updateExpenseSchema = z.object({
  description: trimmedString(LIMITS.EXPENSE_DESC_MAX, "Description").optional(),
  amount: amount.optional(),
  paidBy: objectId.optional(),
  participantIds: participantIds.optional(),
  splitType: z.nativeEnum(SPLIT_TYPES).optional(),
  expenseDate,
  notes: z.string().trim().max(LIMITS.EXPENSE_NOTES_MAX).optional(),
  // Required: an update must state the version it read, so a concurrent edit is
  // rejected instead of silently overwritten.
  version: z.coerce.number().int().min(0),
});

const expenseParamsSchema = z.object({
  inviteCode: z.string().min(8).max(32),
  expenseId: objectId,
});

const listExpensesQuery = paginationQuery.extend({
  memberId: objectId.optional(),
});

module.exports = {
  createExpenseSchema,
  updateExpenseSchema,
  expenseParamsSchema,
  listExpensesQuery,
};
