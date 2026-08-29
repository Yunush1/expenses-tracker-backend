const test = require("node:test");
const assert = require("node:assert/strict");

const { describeWritability, previousMonthKey } = require("../src/utils/expensePeriod");

/**
 * The month lock: current month open, previous month open for a grace period,
 * everything older closed.
 *
 * The cases that matter are the boundaries — the last hour of the grace period,
 * the first hour after it, and the year rollover, which is the one place naive
 * month arithmetic goes wrong (December's previous month is not month zero).
 *
 * The zone is load-bearing: computed in UTC, a month would end at 05:30 IST and
 * an expense added at 11pm on the 31st would be refused as belonging to a closed
 * month it is plainly still inside.
 */

const OPTIONS = { graceDays: 5, timeZone: "Asia/Kolkata" };

/** An instant expressed in IST, so the tests read as the user experiences them. */
const ist = (text) => new Date(`${text}+05:30`);

test("the current month is always open", () => {
  const now = ist("2026-09-20T12:00:00");
  assert.equal(describeWritability(ist("2026-09-01T00:05:00"), now, OPTIONS).writable, true);
  assert.equal(describeWritability(ist("2026-09-20T12:00:00"), now, OPTIONS).writable, true);
});

test("last month stays open through the grace period", () => {
  // 4 September: inside a five-day grace window.
  const now = ist("2026-09-04T18:00:00");
  const verdict = describeWritability(ist("2026-08-28T20:00:00"), now, OPTIONS);

  assert.equal(verdict.writable, true, "the forgotten 28 August expense must still be addable");
  assert.equal(verdict.reason, "grace period");
});

test("the grace period ends at the end of its last day", () => {
  const lastMoment = ist("2026-09-05T23:59:00");
  assert.equal(describeWritability(ist("2026-08-28T20:00:00"), lastMoment, OPTIONS).writable, true);

  const justAfter = ist("2026-09-06T00:01:00");
  const verdict = describeWritability(ist("2026-08-28T20:00:00"), justAfter, OPTIONS);
  assert.equal(verdict.writable, false);
  assert.equal(verdict.reason, "grace period over");
  assert.match(verdict.message, /History/, "the refusal must say the month is still readable");
});

test("older months are closed even during a grace period", () => {
  // 2 September is inside the window, but July is not last month.
  const now = ist("2026-09-02T10:00:00");
  const verdict = describeWritability(ist("2026-07-15T10:00:00"), now, OPTIONS);

  assert.equal(verdict.writable, false);
  assert.equal(verdict.reason, "closed month");
});

test("a month ends at midnight local, not midnight UTC", () => {
  /**
   * 23:30 IST on 31 August is 18:00 UTC on 31 August — same day either way. The
   * revealing instant is just after midnight IST, which is still 31 August in
   * UTC: an expense dated 1 September must be "current month", not "future".
   */
  const justAfterMidnightIst = ist("2026-09-01T00:30:00");
  const verdict = describeWritability(ist("2026-09-01T00:10:00"), justAfterMidnightIst, OPTIONS);

  assert.equal(verdict.writable, true, "the new month has started in the zone that matters");
  assert.equal(verdict.reason, "current month");
});

test("the year rolls over correctly", () => {
  assert.equal(previousMonthKey("2026-01"), "2025-12");
  assert.equal(previousMonthKey("2026-09"), "2026-08");

  // 3 January: December is last month and still inside the window.
  const now = ist("2027-01-03T10:00:00");
  assert.equal(describeWritability(ist("2026-12-30T10:00:00"), now, OPTIONS).writable, true);

  // 10 January: December has closed.
  const later = ist("2027-01-10T10:00:00");
  assert.equal(describeWritability(ist("2026-12-30T10:00:00"), later, OPTIONS).writable, false);
});

test("a future month is refused with its own reason", () => {
  const now = ist("2026-09-04T10:00:00");
  const verdict = describeWritability(ist("2026-10-01T10:00:00"), now, OPTIONS);

  assert.equal(verdict.writable, false);
  assert.equal(verdict.reason, "future");
});

test("a grace period of zero closes the month immediately", () => {
  const now = ist("2026-09-01T00:10:00");
  const verdict = describeWritability(ist("2026-08-31T23:50:00"), now, { ...OPTIONS, graceDays: 0 });

  assert.equal(verdict.writable, false, "graceDays 0 must mean no window, not an unbounded one");
});

/**
 * The floor the date picker is given, and the rule the write guard applies, have
 * to be the same rule. They are separate functions reading the same config from
 * opposite ends — one judges a date, the other names the boundary — so the tests
 * that matter are the ones that tie them together.
 */

const { earliestWritableDate, isWritable } = require("../src/utils/expensePeriod");

const IST = "Asia/Kolkata";

test("the floor is last month's 1st inside the grace window, this month's after", () => {
  const options = { graceDays: 5, timeZone: IST };

  // 3rd of September: last month is still open, so the floor drops to 1 August.
  assert.equal(earliestWritableDate(new Date("2026-09-03T10:00:00Z"), options), "2026-08-01");

  // The last day of the window is still inside it.
  assert.equal(earliestWritableDate(new Date("2026-09-05T10:00:00Z"), options), "2026-08-01");

  // The day after it closes, only September remains.
  assert.equal(earliestWritableDate(new Date("2026-09-06T10:00:00Z"), options), "2026-09-01");
});

test("the floor wraps across the new year", () => {
  const options = { graceDays: 5, timeZone: IST };

  assert.equal(earliestWritableDate(new Date("2026-01-02T10:00:00Z"), options), "2025-12-01");
  assert.equal(earliestWritableDate(new Date("2026-01-20T10:00:00Z"), options), "2026-01-01");
});

test("graceDays: 0 leaves only the current month open", () => {
  const options = { graceDays: 0, timeZone: IST };

  // Even on the 1st, with no grace configured, last month is already shut.
  assert.equal(earliestWritableDate(new Date("2026-09-01T10:00:00Z"), options), "2026-09-01");
});

test("the floor is writable and the day before it is not", () => {
  /**
   * The property that makes the picker honest. If these two ever disagree the
   * picker offers a date the guard refuses, or hides one it would have accepted —
   * and both are invisible until somebody hits Save.
   *
   * Swept across a whole year of instants, including every grace boundary and
   * both year wraps.
   */
  for (const graceDays of [0, 1, 5, 10]) {
    const options = { graceDays, timeZone: IST };

    for (let day = 0; day < 365; day += 1) {
      const now = new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + day * 86400000);
      const floor = earliestWritableDate(now, options);

      // Midday local, so the assertion is about the date rather than about the
      // offset between IST and UTC.
      const floorNoon = new Date(`${floor}T12:00:00+05:30`);
      const dayBefore = new Date(floorNoon.getTime() - 86400000);

      assert.ok(
        isWritable(floorNoon, now, options),
        `grace ${graceDays}, ${now.toISOString()}: the picker's floor ${floor} is refused by the guard`
      );

      assert.ok(
        !isWritable(dayBefore, now, options),
        `grace ${graceDays}, ${now.toISOString()}: ${dayBefore.toISOString()} is before the floor ${floor} but the guard allows it`
      );
    }
  }
});
