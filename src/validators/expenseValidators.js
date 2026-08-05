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

/**
 * Shape only. What the numbers have to mean — percentages totalling 100, exact
 * amounts totalling the expense, one value per participant — is enforced in
 * splitCalculator, so create and update share a single set of rules.
 */
const splitValues = z
  .array(
    z.object({
      memberId: objectId,
      value: z.union([z.number(), z.string()]),
    })
  )
  .max(LIMITS.MAX_PARTICIPANTS, `At most ${LIMITS.MAX_PARTICIPANTS} participants`)
  .optional();

const createExpenseSchema = z.object({
  description: trimmedString(LIMITS.EXPENSE_DESC_MAX, "Description"),
  amount,
  paidBy: objectId,
  participantIds,
  splitType: z.nativeEnum(SPLIT_TYPES).optional().default(SPLIT_TYPES.EQUAL),
  splitValues,
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
  splitValues,
  expenseDate,
  notes: z.string().trim().max(LIMITS.EXPENSE_NOTES_MAX).optional(),
  // Required: an update must state the version it read, so a concurrent edit is
  // rejected instead of silently overwritten.
  version: z.coerce.number().int().min(0),
});

/**
 * Several expenses entered in one go — one shop trip, one receipt, several lines.
 * The payer and date are stated once because that is what makes the entry quick;
 * everything else is per item, so each line can be split differently.
 */
const createExpenseBatchSchema = z.object({
  paidBy: objectId,
  expenseDate,
  items: z
    .array(
      z.object({
        description: trimmedString(LIMITS.EXPENSE_DESC_MAX, "Description"),
        amount,
        participantIds,
        splitType: z.nativeEnum(SPLIT_TYPES).optional().default(SPLIT_TYPES.EQUAL),
        splitValues,
        notes: z.string().trim().max(LIMITS.EXPENSE_NOTES_MAX).optional().default(""),
        // One key per item, not per request: a retry must not turn three items
        // into six, and the items are independent records on the server.
        clientRequestId,
      })
    )
    .min(1, "Add at least one item")
    .max(LIMITS.MAX_BATCH_ITEMS, `At most ${LIMITS.MAX_BATCH_ITEMS} items at a time`),
});

const expenseParamsSchema = z.object({
  inviteCode: z.string().min(8).max(32),
  expenseId: objectId,
});

const listExpensesQuery = paginationQuery.extend({
  /** Expenses that *concern* this member — paid by them, or split onto them. */
  memberId: objectId.optional(),
  /** Expenses this member *entered*. See expenseRepository.listByGroup. */
  paidBy: objectId.optional(),
});

module.exports = {
  createExpenseSchema,
  createExpenseBatchSchema,
  updateExpenseSchema,
  expenseParamsSchema,
  listExpensesQuery,
};
