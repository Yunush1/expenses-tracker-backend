const { z } = require("zod");
const { objectId, amount, trimmedString, clientRequestId, paginationQuery } = require("./common");
const { LIMITS, SPLIT_TYPES, LEDGER_CATEGORIES } = require("../constants");

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

/**
 * What this expense is, when somebody has said.
 *
 * Three states, and all three are meaningful:
 *
 *   omitted   → let the server infer it from the description (the default)
 *   `null`    → the same, explicitly — how an edit clears a choice back to auto
 *   a value   → that category, which always beats inference
 *
 * A closed enum rather than free text, for the reason already argued at
 * `LEDGER_CATEGORIES`: an open field becomes forty spellings of "food", and the
 * breakdown built on it stops being a breakdown.
 */
const category = z.enum(LEDGER_CATEGORIES).nullable().optional();

const createExpenseSchema = z.object({
  description: trimmedString(LIMITS.EXPENSE_DESC_MAX, "Description"),
  amount,
  paidBy: objectId,
  participantIds,
  splitType: z.nativeEnum(SPLIT_TYPES).optional().default(SPLIT_TYPES.EQUAL),
  splitValues,
  expenseDate,
  category,
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
  category,
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
        category,
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
  /** Substring of the description or the notes, case-insensitive. */
  q: z.string().trim().max(80).optional(),
  /** One of LEDGER_CATEGORIES, or `UNCATEGORISED` for the ones with none. */
  category: z.enum([...LEDGER_CATEGORIES, "UNCATEGORISED"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /**
   * Which date `from`/`to` and the date sort refer to.
   *
   * A closed set rather than a free string: it is interpolated into a Mongo query
   * key, and a caller-controlled field name there would let anyone sort and filter
   * by any field on the document.
   */
  dateField: z.enum(["expenseDate", "createdAt"]).optional().default("expenseDate"),
  sort: z
    .enum(["date_desc", "date_asc", "amount_desc", "amount_asc"])
    .optional()
    .default("date_desc"),
});

module.exports = {
  createExpenseSchema,
  createExpenseBatchSchema,
  updateExpenseSchema,
  expenseParamsSchema,
  listExpensesQuery,
};
