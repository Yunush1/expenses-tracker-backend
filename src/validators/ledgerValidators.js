const { z } = require("zod");
const { amount, objectId, paginationQuery, trimmedString } = require("./common");
const { LEDGER_ENTRY_TYPES, LEDGER_CATEGORIES, LIMITS } = require("../constants");

/**
 * Shape only. What the values have to *mean* — a repayment not exceeding the
 * principal, a due date only on a debt — is enforced in ledgerService, so create
 * and update share one set of rules rather than two that drift.
 */

const category = z.enum(LEDGER_CATEGORIES).optional();

/** Guards against a mistyped year filing a spend in 2036, as expenses do. */
const pastish = z.coerce
  .date()
  .refine((date) => date.getTime() <= Date.now() + 24 * 60 * 60 * 1000, {
    message: "That date is in the future",
  })
  .optional();

const counterpartyName = z
  .string()
  .trim()
  .max(LIMITS.LEDGER_COUNTERPARTY_MAX, `Name must be ${LIMITS.LEDGER_COUNTERPARTY_MAX} characters or fewer`)
  .optional();

const createEntrySchema = z.object({
  type: z.nativeEnum(LEDGER_ENTRY_TYPES),
  amount,
  description: trimmedString(LIMITS.LEDGER_DESC_MAX, "Description"),
  counterpartyName,
  /**
   * Who the counterparty is, when they were picked from a shared group rather
   * than typed (docs/17-MEMBER-IDENTITY.md §7). The service still checks that
   * the member is in a group the caller belongs to — this only checks shape.
   */
  counterpartyMemberId: objectId.optional(),
  category,
  occurredAt: pastish,
  /** A due date is the *only* thing that opts an entry into a reminder, so unlike
   *  `occurredAt` it is allowed — expected, even — to be in the future. */
  dueAt: z.coerce.date().optional(),
  notes: z.string().trim().max(LIMITS.LEDGER_NOTE_MAX).optional(),
});

const updateEntrySchema = z.object({
  /**
   * Changing what an entry *is* — "I lent that" when it was logged as spent.
   *
   * Editable because the mistake is easy to make and, before this, unfixable
   * except by deleting and retyping, which loses the repayment history that was
   * the reason to keep the row. What each change is allowed to do to that history
   * is decided in ledgerService, not here.
   */
  type: z.nativeEnum(LEDGER_ENTRY_TYPES).optional(),
  amount: amount.optional(),
  description: trimmedString(LIMITS.LEDGER_DESC_MAX, "Description").optional(),
  counterpartyName,
  category,
  occurredAt: pastish,
  dueAt: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(LIMITS.LEDGER_NOTE_MAX).optional(),
  // Required: an update must state the version it read, so a concurrent edit is
  // rejected rather than silently overwritten.
  version: z.coerce.number().int().min(0),
});

const addRepaymentSchema = z.object({
  amount,
  paidAt: pastish,
  note: z.string().trim().max(LIMITS.LEDGER_NOTE_MAX).optional(),
});

const listEntriesQuery = paginationQuery.extend({
  type: z.nativeEnum(LEDGER_ENTRY_TYPES).optional(),
  /** Tri-state on purpose: absent means "either", not "unsettled". */
  settled: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  /**
   * Which half of the ledger. Absent means both — the tabs pass one, and anything
   * else reading this endpoint keeps the whole picture it had before.
   */
  source: z.enum(["MANUAL", "GROUP_EXPENSE"]).optional(),
});

const entryParams = z.object({ id: objectId });
const repaymentParams = z.object({ id: objectId, repaymentId: objectId });

module.exports = {
  createEntrySchema,
  updateEntrySchema,
  addRepaymentSchema,
  listEntriesQuery,
  entryParams,
  repaymentParams,
};
