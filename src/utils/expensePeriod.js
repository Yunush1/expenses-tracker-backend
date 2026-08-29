/**
 * Which months an expense may still be written to.
 *
 * ## What this implements, and the trade it makes
 *
 * The rule the product chose: **the current month is open, the month before it
 * stays open for a short grace period, and everything older is locked.** History
 * remains readable; it just cannot be changed.
 *
 * docs/28-SETTLEMENT-DESIGN.md argues against locking at all, on the grounds that
 * the money was still spent and a lock only decides *who absorbs it*. That
 * argument is not repeated here because the decision was made deliberately; what
 * matters now is that the lock is implemented in the one place it cannot be
 * bypassed, and that it locks **only editing**.
 *
 * ## What this must never touch
 *
 * **Balances, settle-up and settlements are all-time and are not period-scoped**
 * (docs/14-PERIODS.md §3). Paying an August debt in November is the normal case,
 * not a late edit, so nothing in this file is applied to settlements. If it ever
 * were, a locked month would trap a debt that can never be cleared — the app
 * would be telling somebody they owe money and refusing to let them record
 * paying it.
 *
 * ## Why a timezone
 *
 * "The month" is a local idea. Computed in UTC, a month would end at 05:30 in
 * India and an expense added late on the 31st would land in the next one. The
 * zone is configurable and defaults to the same value the nudge scheduler
 * already uses.
 */

/** `2026-08-28` in the given zone — en-CA formats as ISO, which is why it is used. */
const localParts = (date, timeZone) => {
  const text = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  return { monthKey: text.slice(0, 7), day: Number(text.slice(8, 10)) };
};

/** `2026-09` → `2026-08`. */
const previousMonthKey = (monthKey) => {
  const [year, month] = monthKey.split("-").map(Number);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
};

/**
 * May an expense dated `date` be created, edited or deleted right now?
 *
 * Returns a reason rather than a bare boolean, because the three refusals need
 * different sentences: one tells you the window has closed, another that the
 * month is long gone.
 *
 * @param {Date}   date       the expense's own date — when the money was spent
 * @param {Date}   now        the current instant
 * @param {object} options
 * @param {number} options.graceDays  how far into a month the previous one stays open
 * @param {string} options.timeZone   the zone that decides where a month ends
 */
const describeWritability = (date, now, { graceDays, timeZone }) => {
  const expense = localParts(date, timeZone);
  const today = localParts(now, timeZone);

  if (expense.monthKey === today.monthKey) {
    return { writable: true, reason: "current month" };
  }

  /**
   * A future month. The validator already refuses future *dates*; this catches
   * the case where a clock or a timezone puts one a month ahead, and refuses it
   * for a reason that names the real problem.
   */
  if (expense.monthKey > today.monthKey) {
    return { writable: false, reason: "future", message: "That date is in the future." };
  }

  if (expense.monthKey === previousMonthKey(today.monthKey)) {
    if (today.day <= graceDays) {
      return { writable: true, reason: "grace period" };
    }

    return {
      writable: false,
      reason: "grace period over",
      message:
        `Last month closed on the ${ordinal(graceDays)}. ` +
        "It is still in History, but it can no longer be changed.",
    };
  }

  return {
    writable: false,
    reason: "closed month",
    message: "That month is closed. It is still in History, but it can no longer be changed.",
  };
};

/** 1st, 2nd, 3rd, 5th — for a sentence a person reads. */
const ordinal = (n) => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix}`;
};

const isWritable = (date, now, options) => describeWritability(date, now, options).writable;

/**
 * The earliest date still writable right now, as `YYYY-MM-DD`.
 *
 * The same rule as `describeWritability`, read from the other end: rather than
 * judging a date it names the floor. That is what a date picker needs — a client
 * that only has the "is this allowed" form has to guess at the boundary, and
 * guessing means duplicating `graceDays` and the timezone in the browser, where
 * they drift the moment either is changed here.
 *
 * Published on the periods response so the picker cannot offer a day the server
 * will refuse. It is a courtesy, not a control: the guard on every write is still
 * the thing that enforces the lock.
 */
const earliestWritableDate = (now, { graceDays, timeZone }) => {
  const today = localParts(now, timeZone);

  // Inside the grace window the previous month is still open, so the floor drops
  // back to its 1st. After it, only the current month remains.
  const openMonth = today.day <= graceDays ? previousMonthKey(today.monthKey) : today.monthKey;

  return `${openMonth}-01`;
};

module.exports = {
  describeWritability,
  isWritable,
  earliestWritableDate,
  previousMonthKey,
  localParts,
};
