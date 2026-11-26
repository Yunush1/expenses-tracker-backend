const { z } = require("zod");
const { objectId, amount, clientRequestId } = require("./common");
const { LIMITS, SETTLEMENT_METHODS, PAYMENT_METHODS } = require("../constants");

const createSettlementSchema = z
  .object({
    fromMemberId: objectId,
    toMemberId: objectId,
    amount,
    /**
     * Real payment methods only. OFFSET and CARRY_FORWARD are written by the dues
     * module in mirrored pairs; one arriving here alone would be half a pair — a
     * row that claims no money moved while moving a balance as if it had.
     */
    method: z.enum(PAYMENT_METHODS).optional().default(SETTLEMENT_METHODS.MANUAL),
    note: z.string().trim().max(LIMITS.SETTLEMENT_NOTE_MAX).optional().default(""),
    settledAt: z.coerce.date().optional(),
    /**
     * Monthly groups: pay this specific month's due (`2026-09`). Omitted, the
     * payment is spread oldest-first across what is owed. Ignored in continuous
     * groups, which have no months to pay.
     */
    periodKey: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must look like 2026-09")
      .optional(),
    clientRequestId,
  })
  .refine((data) => data.fromMemberId !== data.toMemberId, {
    message: "A member cannot settle with themselves",
    path: ["toMemberId"],
  });

module.exports = { createSettlementSchema };
