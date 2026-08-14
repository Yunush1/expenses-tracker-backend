const { z } = require("zod");
const { objectId, amount, trimmedString } = require("./common");
const { LIMITS, SPLIT_TYPES, RECURRENCE, LEDGER_CATEGORIES } = require("../constants");

/**
 * Shape only. What a split has to add up to is enforced by `splitCalculator`, and
 * how many templates a group may hold is enforced by the entitlement layer — both
 * in the service, so there is one answer rather than two that can disagree.
 */

const participantIds = z
  .array(objectId)
  .min(1, "Select at least one participant")
  .max(LIMITS.MAX_PARTICIPANTS, `At most ${LIMITS.MAX_PARTICIPANTS} participants`);

const splitValues = z
  .array(z.object({ memberId: objectId, value: z.union([z.number(), z.string()]) }))
  .max(LIMITS.MAX_PARTICIPANTS)
  .optional();

const category = z.enum(LEDGER_CATEGORIES).nullable().optional();

/**
 * Which day it fires on.
 *
 * `dayOfMonth` accepts 29, 30 and 31, and the schedule clamps them to the length
 * of each month rather than skipping — a flatshare must not lose February's rent
 * for having chosen the 31st. See utils/recurrence.
 */
const schedule = {
  frequency: z.nativeEnum(RECURRENCE).optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(31).optional(),
  weekday: z.coerce.number().int().min(0).max(6).optional(),
};

const createRecurringSchema = z.object({
  description: trimmedString(LIMITS.EXPENSE_DESC_MAX, "Description"),
  amount,
  paidBy: objectId,
  participantIds,
  splitType: z.nativeEnum(SPLIT_TYPES).optional().default(SPLIT_TYPES.EQUAL),
  splitValues,
  category,
  notes: z.string().trim().max(LIMITS.EXPENSE_NOTES_MAX).optional().default(""),
  ...schedule,
  /**
   * When the schedule begins. A past date is floored to today in the service — a
   * template backdated to last year would otherwise materialise a year of expenses
   * on its first tick.
   */
  startsOn: z.coerce.date().optional(),
  /** When it stops. Null, or absent, means "until somebody says otherwise". */
  endsOn: z.coerce.date().nullable().optional(),
});

/**
 * No `version` field, unlike an expense edit.
 *
 * Optimistic concurrency exists on expenses because two people editing one row is
 * a real race over money that has already moved. A template is configuration that
 * one person sets up and rarely touches, and the cost of a lost update here is a
 * setting to change again — not a balance that is quietly wrong.
 */
const updateRecurringSchema = z
  .object({
    description: trimmedString(LIMITS.EXPENSE_DESC_MAX, "Description").optional(),
    amount: amount.optional(),
    paidBy: objectId.optional(),
    participantIds: participantIds.optional(),
    splitType: z.nativeEnum(SPLIT_TYPES).optional(),
    splitValues,
    category,
    notes: z.string().trim().max(LIMITS.EXPENSE_NOTES_MAX).optional(),
    ...schedule,
    endsOn: z.coerce.date().nullable().optional(),
    /** Stop and start it, without losing what it is. */
    isPaused: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Nothing to change",
  });

module.exports = { createRecurringSchema, updateRecurringSchema };
