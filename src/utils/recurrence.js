const { RECURRENCE } = require("../constants");

/**
 * When a recurring expense fires next (docs/16-TODO.md §2.2).
 *
 * Pure, and every function takes its clock as an argument, because this is the
 * part of the feature that is genuinely hard to get right and therefore the part
 * worth being able to test at 23:59 on 31 January without waiting for January.
 *
 * ## Everything here is a DATE, not an instant
 *
 * Dates are normalised to UTC midnight. "Rent on the 1st" is a claim about a day,
 * not a moment, and the alternative — storing the time of day the template was
 * created — makes the whole thing depend on when somebody happened to set it up.
 * It also makes the idempotency key stable: one expense per template per *date*,
 * whatever time the job happens to run.
 *
 * The cost, stated plainly: for a user far from UTC, a template due "on the 1st"
 * materialises during the evening of the 31st or the morning of the 1st depending
 * on where they are. It lands on the right date either way, which is the thing
 * being promised.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Any date → UTC midnight of that day. */
const startOfDay = (date) => {
  const value = new Date(date);
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
};

/** `YYYY-MM-DD` in UTC — the date half of the idempotency key. */
const dateKey = (date) => startOfDay(date).toISOString().slice(0, 10);

/** How many days a given month has. Day 0 of the next month is the last of this. */
const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * The `dayOfMonth`-th of a given month, clamped to the month's length.
 *
 * The 31st in April is the 30th, and in February the 28th or 29th. **Clamped, not
 * skipped** — a flatshare silently missing a month's rent because February is
 * short is the worst thing this feature could do, and "the 31st" means "the end of
 * the month" to everybody who types it.
 */
const dayInMonth = (year, monthIndex, dayOfMonth) =>
  new Date(Date.UTC(year, monthIndex, Math.min(dayOfMonth, daysInMonth(year, monthIndex))));

/**
 * The first date on or after `from` that matches the rule.
 *
 * Used both when a template is created — so "rent on the 1st", set up on the 20th,
 * fires on the 1st of next month rather than immediately — and to seed a schedule
 * after an edit.
 */
const firstRunOnOrAfter = (rule, from = new Date()) => {
  const start = startOfDay(from);

  if (rule.frequency === RECURRENCE.DAILY) return start;

  if (rule.frequency === RECURRENCE.WEEKLY) {
    const target = Number(rule.weekday ?? 1);
    const delta = (target - start.getUTCDay() + 7) % 7;
    return new Date(start.getTime() + delta * DAY_MS);
  }

  const dayOfMonth = Number(rule.dayOfMonth ?? 1);
  const thisMonth = dayInMonth(start.getUTCFullYear(), start.getUTCMonth(), dayOfMonth);

  if (thisMonth.getTime() >= start.getTime()) return thisMonth;

  return dayInMonth(start.getUTCFullYear(), start.getUTCMonth() + 1, dayOfMonth);
};

/**
 * The run after `current`.
 *
 * Monthly steps by *month index* and re-clamps, rather than adding 30 days: adding
 * days drifts, so a template set for the 31st would walk backwards through the
 * calendar — 31 Jan, 2 Mar, 1 Apr — and stop being "the end of the month" within a
 * quarter. Stepping the month and clamping keeps 31 Jan → 28 Feb → 31 Mar, which
 * is what the person meant.
 */
const nextRunAfter = (rule, current) => {
  const from = startOfDay(current);

  if (rule.frequency === RECURRENCE.DAILY) return new Date(from.getTime() + DAY_MS);
  if (rule.frequency === RECURRENCE.WEEKLY) return new Date(from.getTime() + 7 * DAY_MS);

  const dayOfMonth = Number(rule.dayOfMonth ?? 1);
  return dayInMonth(from.getUTCFullYear(), from.getUTCMonth() + 1, dayOfMonth);
};

/**
 * Every due date from `nextRunAt` up to and including today, oldest first.
 *
 * ## Why this catches up, and why it is bounded
 *
 * A server down for four days, or a template created before a deploy, leaves due
 * dates in the past. Producing them is right: the rent for the 1st is owed whether
 * or not the process was running on the 1st, and a group whose January rent
 * silently never appeared would find its balances quietly wrong.
 *
 * But it is bounded by `maxCatchUp`, because the failure mode in the other
 * direction is worse and irreversible-feeling: a bug, a clock skew or a restored
 * backup with a stale `nextRunAt` would otherwise post a year of daily expenses
 * into a live group in one tick, moving everybody's balance. Past the bound the
 * schedule is fast-forwarded to the present without materialising the gap, and the
 * skip is logged.
 *
 * This is also why the job runs on a schedule rather than lazily on page load: a
 * group nobody opens for three weeks must not produce three weeks of expenses the
 * moment somebody looks at it (docs/16-TODO.md §2.2).
 */
const dueDates = (rule, { now = new Date(), maxCatchUp = 12 } = {}) => {
  const today = startOfDay(now);
  const dates = [];

  let cursor = startOfDay(rule.nextRunAt);

  while (cursor.getTime() <= today.getTime() && dates.length < maxCatchUp) {
    if (rule.endsOn && cursor.getTime() > startOfDay(rule.endsOn).getTime()) break;
    dates.push(cursor);
    cursor = nextRunAfter(rule, cursor);
  }

  return {
    dates,
    /** Where the schedule stands after these have been produced. */
    nextRunAt: cursor,
    /** True when the bound was hit, meaning dates were deliberately not produced. */
    truncated: dates.length >= maxCatchUp && cursor.getTime() <= today.getTime(),
  };
};

/** Has this template reached its end date? */
const hasEnded = (rule, now = new Date()) =>
  Boolean(rule.endsOn) && startOfDay(now).getTime() > startOfDay(rule.endsOn).getTime();

/**
 * The idempotency key for one materialisation.
 *
 * Template id plus due date, so a double run, a retry, a restart or two instances
 * ticking at once all produce the same key — and the unique partial index on
 * `{ groupId, clientRequestId }` turns the second write into a no-op rather than a
 * second charge on somebody's flatmate. Idempotency is the whole feature.
 */
const materialisationKey = (templateId, date) => `rec:${String(templateId)}:${dateKey(date)}`;

module.exports = {
  startOfDay,
  dateKey,
  daysInMonth,
  dayInMonth,
  firstRunOnOrAfter,
  nextRunAfter,
  dueDates,
  hasEnded,
  materialisationKey,
};
