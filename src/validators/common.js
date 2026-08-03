const { z } = require("zod");
const mongoose = require("mongoose");
const { LIMITS } = require("../constants");

/** Shared primitives so every endpoint validates ids, amounts and paging identically. */

const objectId = z
  .string()
  .refine((value) => mongoose.Types.ObjectId.isValid(value), { message: "Invalid id" });

/**
 * Accepts a number or a numeric string (JSON bodies from forms send both) and
 * enforces the currency's precision here, at the boundary. money.toMinor performs
 * the authoritative conversion afterwards.
 */
const amount = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === "string" ? Number(value.trim()) : value))
  .refine((value) => Number.isFinite(value), { message: "Amount must be a valid number" })
  .refine((value) => value > 0, { message: "Amount must be greater than zero" })
  .refine((value) => value <= LIMITS.MAX_AMOUNT_MAJOR, {
    message: `Amount must not exceed ${LIMITS.MAX_AMOUNT_MAJOR}`,
  })
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: "Amount cannot have more than 2 decimal places",
  });

const paginationQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.MAX_PAGE_SIZE)
    .optional()
    .default(LIMITS.DEFAULT_PAGE_SIZE),
});

const inviteCodeParams = z.object({
  inviteCode: z.string().min(8).max(32),
});

const trimmedString = (max, label) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

const clientRequestId = z.string().trim().max(64).optional();

module.exports = {
  objectId,
  amount,
  paginationQuery,
  inviteCodeParams,
  trimmedString,
  clientRequestId,
};
