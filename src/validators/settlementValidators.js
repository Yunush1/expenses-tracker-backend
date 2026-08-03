const { z } = require("zod");
const { objectId, amount, clientRequestId } = require("./common");
const { LIMITS, SETTLEMENT_METHODS } = require("../constants");

const createSettlementSchema = z
  .object({
    fromMemberId: objectId,
    toMemberId: objectId,
    amount,
    method: z.nativeEnum(SETTLEMENT_METHODS).optional().default(SETTLEMENT_METHODS.MANUAL),
    note: z.string().trim().max(LIMITS.SETTLEMENT_NOTE_MAX).optional().default(""),
    settledAt: z.coerce.date().optional(),
    clientRequestId,
  })
  .refine((data) => data.fromMemberId !== data.toMemberId, {
    message: "A member cannot settle with themselves",
    path: ["toMemberId"],
  });

module.exports = { createSettlementSchema };
