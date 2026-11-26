const { z } = require("zod");
const { objectId, amount } = require("./common");
const { LIMITS, DUE_REQUEST_KINDS } = require("../constants");

/** Previous dues, offsets and requests — docs/29-BALANCE-CYCLES.md. */

const note = z.string().trim().max(LIMITS.SETTLEMENT_NOTE_MAX).optional().default("");

/** `amount` omitted means "as much as can be offset". */
const offsetSchema = z.object({
  counterpartyMemberId: objectId,
  amount: amount.optional(),
  note,
});

const createDueRequestSchema = z.object({
  kind: z.nativeEnum(DUE_REQUEST_KINDS),
  counterpartyMemberId: objectId,
  /**
   * MERGE only, and only needed when the two people each owe the other from
   * earlier months — otherwise the direction is obvious and is worked out.
   */
  direction: z.enum(["I_OWE", "OWED_TO_ME"]).optional(),
  /** Omitted means everything owed from earlier months. Less is a partial merge. */
  amount: amount.optional(),
  note,
});

const respondDueRequestSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
});

const reopenSchema = z.object({
  /** `YYYY-MM-DD`, or null for no end date. Omitted keeps the current one. */
  endDate: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must look like 2026-10-05"), z.null()])
    .optional()
    .transform((value) => (value ? new Date(`${value}T00:00:00Z`) : value)),
});

module.exports = { offsetSchema, createDueRequestSchema, respondDueRequestSchema, reopenSchema };
