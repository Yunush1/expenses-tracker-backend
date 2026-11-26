const { z } = require("zod");
const { trimmedString } = require("./common");
const { LIMITS, DEFAULT_CURRENCY, BALANCE_CYCLES } = require("../constants");
const { SUPPORTED_CURRENCIES } = require("../utils/money");

/**
 * Shape only. Whether a code is well-formed, free, or reserved is decided in
 * groupService, so create and update share one set of rules.
 *
 * `null` is meaningful and must survive validation: it is how the creator turns the
 * short code off.
 */
const joinCode = z.union([z.string().trim().max(24), z.null()]).optional();

/**
 * A calendar day, `YYYY-MM-DD` → UTC midnight of that day. A day rather than an
 * instant, so "the trip ends on the 5th" means the whole of the 5th wherever the
 * group is (models/group.js).
 */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must look like 2026-10-05")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), { message: "That is not a real date" })
  .transform((value) => new Date(`${value}T00:00:00Z`));

const nullableDay = z.union([calendarDay, z.null()]).optional();

/** docs/29-BALANCE-CYCLES.md — the PRD's "split type", named apart from an expense's. */
const balanceCycle = z.nativeEnum(BALANCE_CYCLES);

const endNotBeforeStart = (data) => !data.startDate || !data.endDate || data.endDate >= data.startDate;

const createGroupSchema = z.object({
  name: trimmedString(LIMITS.GROUP_NAME_MAX, "Group name"),
  description: z.string().trim().max(LIMITS.GROUP_DESC_MAX).optional().default(""),
  creatorName: trimmedString(LIMITS.MEMBER_NAME_MAX, "Your name"),
  /**
   * An allowlist, not "any three letters".
   *
   * `utils/money.js` falls back to a scale of 100 for a code it does not know.
   * That is right for *display* — a number beats a crash — and catastrophic for
   * *storage*: a group created in KWD, which has three decimal places, would have
   * every amount stored ten times too small, with nothing reporting an error
   * (docs/27-MULTI-CURRENCY.md §3).
   *
   * A group's currency is also immutable — `updateGroupSchema` below deliberately
   * omits it, because the stored integers carry no currency of their own and
   * changing it would reinterpret every amount rather than convert it.
   */
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((code) => SUPPORTED_CURRENCIES.includes(code), {
      message: "That currency is not supported",
    })
    .optional()
    .default(DEFAULT_CURRENCY),
  joinCode,
  /** Monthly unless asked otherwise — the PRD's default (§5.1). */
  balanceCycle: balanceCycle.optional().default(BALANCE_CYCLES.MONTHLY),
  /** Continuous only. Defaults to the day the group is created. */
  startDate: calendarDay.optional(),
  /** Continuous only, and optional: without one the creator closes it by hand. */
  endDate: nullableDay,
})
  .refine(
    (data) => data.balanceCycle === BALANCE_CYCLES.CONTINUOUS || (!data.startDate && !data.endDate),
    { message: "Start and end dates are for continuous groups — a monthly group follows the calendar", path: ["startDate"] }
  )
  .refine(endNotBeforeStart, { message: "The end date is before the start date", path: ["endDate"] });

const updateGroupSchema = z
  .object({
    name: trimmedString(LIMITS.GROUP_NAME_MAX, "Group name").optional(),
    description: z.string().trim().max(LIMITS.GROUP_DESC_MAX).optional(),
    joinCode,
    /** Approval for new members. See models/group.js for what it gates. */
    isPrivate: z.boolean().optional(),
    /** Only while the group has no expenses — see groupService.updateGroup. */
    balanceCycle: balanceCycle.optional(),
    startDate: nullableDay,
    endDate: nullableDay,
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.joinCode !== undefined ||
      data.isPrivate !== undefined ||
      data.balanceCycle !== undefined ||
      data.startDate !== undefined ||
      data.endDate !== undefined,
    { message: "Provide a name, description, join code, privacy setting, cycle or dates to update" }
  )
  .refine(endNotBeforeStart, { message: "The end date is before the start date", path: ["endDate"] });

const lookupQuerySchema = z.object({
  code: z.string().trim().min(1, "Enter a group code").max(24),
});

module.exports = { createGroupSchema, updateGroupSchema, lookupQuerySchema };
