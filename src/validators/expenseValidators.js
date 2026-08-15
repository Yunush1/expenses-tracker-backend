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
/**
 * A stored receipt photo, by URL.
 *
 * Deliberately **not** free text and not a URL of the caller's choosing: it must
 * match a path this server itself produced (`utils/receiptStorage`), 32 hex
 * characters and one of three extensions. Accepting an arbitrary string here would
 * let anyone point an expense at any URL on the internet, and every member of the
 * group would then load it — an image beacon in somebody else's ledger.
 *
 * A single-element array rather than a scalar because `attachments[]` on the model
 * is a list and always has been (docs/02-HLD.md §9); one per expense is simply
 * what a receipt scan produces.
 */
const attachments = z
  .array(z.string().regex(/^\/uploads\/receipts\/[a-f0-9]{32}\.(?:jpg|png|webp)$/))
  .max(1)
  .optional();

/**
 * What the receipt said, as read by the scan.
 *
 * **Provenance, never money.** Nothing in here is used by a balance, a split or a
 * settlement, so it is validated for shape and bounds and not for agreement with
 * the amounts beside it — a total that disagrees with the lines is a fact about
 * the bill (tax, service, a missed line), not an error to reject.
 *
 * Minor units, like every other amount crossing this boundary, and `nullish`
 * throughout because a receipt legitimately prints only some of these.
 */
const minorAmount = z.number().int().min(0).max(LIMITS.MAX_AMOUNT_MAJOR * 100).nullish();

const receipt = z
  .object({
    merchant: z.string().trim().max(LIMITS.EXPENSE_DESC_MAX).nullish(),
    invoiceNo: z.string().trim().max(40).nullish(),
    gstin: z.string().trim().max(24).nullish(),
    paymentMethod: z.enum(["CASH", "CARD", "UPI", "WALLET"]).nullish(),
    subtotalMinor: minorAmount,
    taxes: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(24),
          amountMinor: z.number().int().min(0),
          rate: z.number().min(0).max(100).nullish(),
        })
      )
      .max(6)
      .optional(),
    serviceMinor: minorAmount,
    discountMinor: minorAmount,
    tipMinor: minorAmount,
    totalMinor: minorAmount,
    /**
     * The photo, and only one this server produced — the same rule as
     * `attachments` above, for the same reason: an arbitrary URL here would be
     * loaded by every member of the group.
     */
    imageUrl: z
      .string()
      .regex(/^\/uploads\/receipts\/[a-f0-9]{32}\.(?:jpg|png|webp)$/)
      .nullish(),
  })
  .nullish();

const createExpenseBatchSchema = z.object({
  paidBy: objectId,
  expenseDate,
  /**
   * Stated once for the whole batch, like the payer and the date: every line came
   * off the same piece of paper, and asking per line would be asking eleven times
   * for one answer.
   */
  attachments,
  receipt,
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
