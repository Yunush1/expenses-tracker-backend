const test = require("node:test");
const assert = require("node:assert/strict");

const recurrence = require("../src/utils/recurrence");
const { RECURRENCE } = require("../src/constants");

/**
 * The schedule arithmetic behind recurring expenses (docs/16-TODO.md §2.2).
 *
 * This is the part of the feature that is genuinely hard, and the failures are
 * expensive in a way most bugs are not: a template that fires twice has taken
 * money from four flatmates, and one that silently skips February has lost a
 * month's rent from the record. Both are asserted here rather than discovered in
 * February.
 *
 * Four properties, in the order they matter:
 *
 * 1. **The end of the month is clamped, never skipped.** "The 31st" means the end
 *    of the month to everybody who types it.
 * 2. **Monthly does not drift.** Stepping by 30 days would walk a 31st backwards
 *    through the calendar within a quarter.
 * 3. **Missed dates are caught up, and the catch-up is bounded.** An outage owes
 *    the rent; a restored backup does not owe a year of it.
 * 4. **The idempotency key is stable per template per date**, whatever time the
 *    job runs, because it is the only thing standing between a retry and a second
 *    rent.
 */

const iso = (date) => date.toISOString().slice(0, 10);
const monthly = (dayOfMonth) => ({ frequency: RECURRENCE.MONTHLY, dayOfMonth });
const at = (dateString) => new Date(`${dateString}T00:00:00Z`);

/* -------------------------- 1. Clamping, not skipping --------------------- */

test("the 31st lands on the last day of a shorter month", () => {
  // April has 30 days and February 28 — a template set for the 31st must still
  // fire in both. Skipping would silently lose a month's rent.
  assert.equal(iso(recurrence.dayInMonth(2026, 3, 31)), "2026-04-30");
  assert.equal(iso(recurrence.dayInMonth(2026, 1, 31)), "2026-02-28");
  assert.equal(iso(recurrence.dayInMonth(2026, 0, 31)), "2026-01-31");
});

test("February gets its extra day in a leap year", () => {
  assert.equal(recurrence.daysInMonth(2028, 1), 29);
  assert.equal(recurrence.daysInMonth(2026, 1), 28);
  assert.equal(iso(recurrence.dayInMonth(2028, 1, 31)), "2028-02-29");
});

test("a 31st walked across a year does not drift", () => {
  /**
   * The property that adding 30 days would break. Stepping by month index and
   * re-clamping keeps 31 Jan → 28 Feb → 31 Mar; adding days gives 31 Jan → 2 Mar →
   * 1 Apr, and within a quarter "the end of the month" has become the 1st.
   */
  const rule = monthly(31);
  let cursor = at("2026-01-31");
  const walked = [];

  for (let i = 0; i < 12; i += 1) {
    cursor = recurrence.nextRunAfter(rule, cursor);
    walked.push(iso(cursor));
  }

  assert.deepEqual(walked, [
    "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
    "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30",
    "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31",
  ]);
});

/* ----------------------------- 2. First run ------------------------------- */

test("a monthly template set up mid-month waits for its day", () => {
  // Rent on the 1st, set up on the 20th, must not fire the moment it is saved.
  assert.equal(iso(recurrence.firstRunOnOrAfter(monthly(1), at("2026-08-20"))), "2026-09-01");
});

test("a template set up on its own day fires that day", () => {
  assert.equal(iso(recurrence.firstRunOnOrAfter(monthly(14), at("2026-08-14"))), "2026-08-14");
});

test("weekly finds the next matching weekday, today included", () => {
  // 2026-08-14 is a Friday (weekday 5).
  const friday = at("2026-08-14");

  assert.equal(iso(recurrence.firstRunOnOrAfter({ frequency: "WEEKLY", weekday: 5 }, friday)), "2026-08-14");
  assert.equal(iso(recurrence.firstRunOnOrAfter({ frequency: "WEEKLY", weekday: 1 }, friday)), "2026-08-17");
  assert.equal(iso(recurrence.firstRunOnOrAfter({ frequency: "WEEKLY", weekday: 4 }, friday)), "2026-08-20");
});

test("daily starts today", () => {
  assert.equal(iso(recurrence.firstRunOnOrAfter({ frequency: "DAILY" }, at("2026-08-14"))), "2026-08-14");
});

/* ------------------------------ 3. Catch-up ------------------------------- */

test("nothing is due before the date arrives", () => {
  const { dates } = recurrence.dueDates(
    { ...monthly(1), nextRunAt: at("2026-09-01") },
    { now: at("2026-08-14") }
  );

  assert.equal(dates.length, 0);
});

test("the due date itself is due", () => {
  const { dates, nextRunAt } = recurrence.dueDates(
    { ...monthly(14), nextRunAt: at("2026-08-14") },
    { now: at("2026-08-14") }
  );

  assert.deepEqual(dates.map(iso), ["2026-08-14"]);
  // The schedule has already moved on, so a second tick the same day finds nothing.
  assert.equal(iso(nextRunAt), "2026-09-14");
});

test("an outage owes the months it missed, dated correctly", () => {
  /**
   * A server down since May. The rent for June, July and August is owed whether or
   * not the process was running — a group whose June rent silently never appeared
   * would find its balances quietly wrong, and nothing would say why.
   */
  const { dates, nextRunAt } = recurrence.dueDates(
    { ...monthly(1), nextRunAt: at("2026-06-01") },
    { now: at("2026-08-14") }
  );

  assert.deepEqual(dates.map(iso), ["2026-06-01", "2026-07-01", "2026-08-01"]);
  assert.equal(iso(nextRunAt), "2026-09-01");
});

test("catch-up is bounded, and says when it truncated", () => {
  /**
   * The failure in the other direction, and the worse one: a restored backup or a
   * clock skew leaves a stale date, and an unbounded catch-up posts years of daily
   * expenses into a live group in one tick — moving everybody's balance, for no
   * reason anybody can see.
   */
  const { dates, truncated } = recurrence.dueDates(
    { frequency: RECURRENCE.DAILY, nextRunAt: at("2020-01-01") },
    { now: at("2026-08-14"), maxCatchUp: 12 }
  );

  assert.equal(dates.length, 12);
  assert.equal(truncated, true, "the caller has to be able to log that it skipped");
});

test("an end date stops the run, mid-catch-up if need be", () => {
  const { dates } = recurrence.dueDates(
    { ...monthly(1), nextRunAt: at("2026-06-01"), endsOn: at("2026-07-15") },
    { now: at("2026-12-01") }
  );

  assert.deepEqual(dates.map(iso), ["2026-06-01", "2026-07-01"]);
});

test("hasEnded is a whole-day comparison", () => {
  const template = { endsOn: at("2026-08-14") };

  // The last day is still inside the run — an end date is inclusive, the way a
  // person reading "ends 14 August" would expect.
  assert.equal(recurrence.hasEnded(template, at("2026-08-14")), false);
  assert.equal(recurrence.hasEnded(template, at("2026-08-15")), true);
  assert.equal(recurrence.hasEnded({ endsOn: null }, at("2099-01-01")), false);
});

/* ---------------------------- 4. Idempotency ------------------------------ */

test("the materialisation key is the same whatever time the job runs", () => {
  /**
   * The single most important assertion in this file. Two instances ticking at
   * 00:05 and 00:47 on the same date must produce the same key, so the unique
   * index turns the second write into a no-op rather than a second rent.
   */
  const morning = recurrence.materialisationKey("abc123", new Date("2026-08-01T00:05:00Z"));
  const evening = recurrence.materialisationKey("abc123", new Date("2026-08-01T23:47:00Z"));

  assert.equal(morning, evening);
  assert.equal(morning, "rec:abc123:2026-08-01");
});

test("different templates and different dates never collide", () => {
  const date = at("2026-08-01");

  assert.notEqual(
    recurrence.materialisationKey("abc123", date),
    recurrence.materialisationKey("def456", date)
  );
  assert.notEqual(
    recurrence.materialisationKey("abc123", at("2026-08-01")),
    recurrence.materialisationKey("abc123", at("2026-09-01"))
  );
});

test("the key fits the column it is stored in", () => {
  // clientRequestId is capped at 64 characters by the validator; an ObjectId is 24.
  const key = recurrence.materialisationKey("6a7f03290a4247bc127224b1", at("2026-08-01"));
  assert.ok(key.length <= 64, `key is ${key.length} characters`);
});

/* ------------------------------ Day handling ------------------------------ */

test("every date is normalised to UTC midnight", () => {
  /**
   * A due date is a claim about a day, not a moment. If the time of day survived,
   * the idempotency key would still hold — it truncates — but `dueDates` would
   * compare instants and a template created at 14:00 would not be due until 14:00.
   */
  const messy = recurrence.startOfDay(new Date("2026-08-14T23:59:59.999Z"));

  assert.equal(messy.toISOString(), "2026-08-14T00:00:00.000Z");
  assert.equal(recurrence.dateKey(new Date("2026-08-14T23:59:59Z")), "2026-08-14");
});
