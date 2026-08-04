/**
 * Reading the wall clock in someone else's timezone.
 *
 * Node ships full ICU, so `Intl` knows every IANA zone and its DST history. That
 * makes these three helpers enough for the daily nudge, and avoids taking a date
 * library as a dependency for what amounts to three questions.
 */

/** The device's own calendar date as `YYYY-MM-DD`. `en-CA` formats in ISO order. */
const localDateString = (date, timeZone) => date.toLocaleDateString("en-CA", { timeZone });

/** Minutes since the device's local midnight — 20:30 is 1230. */
const localMinutesSinceMidnight = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // 24 is what some engines emit for midnight under hour12:false.
  return (value("hour") % 24) * 60 + value("minute");
};

/**
 * The UTC instant at which the device's current local day began.
 *
 * Derived by asking what the same instant reads as in the target zone versus UTC;
 * the difference is that zone's offset right now, DST included. Good to the
 * minute, which is all "did they log anything since this morning" needs. The one
 * imprecision is a DST transition falling between midnight and now, which shifts
 * the boundary by an hour — harmless here, and not worth a dependency to fix.
 */
const startOfLocalDay = (date, timeZone) => {
  const offsetMs =
    new Date(date.toLocaleString("en-US", { timeZone })).getTime() -
    new Date(date.toLocaleString("en-US", { timeZone: "UTC" })).getTime();

  return new Date(Date.parse(`${localDateString(date, timeZone)}T00:00:00Z`) - offsetMs);
};

/** How far ahead of UTC the zone is at this instant, DST included. */
const zoneOffsetMs = (date, timeZone) =>
  new Date(date.toLocaleString("en-US", { timeZone })).getTime() -
  new Date(date.toLocaleString("en-US", { timeZone: "UTC" })).getTime();

/**
 * The UTC instant at which a given wall-clock time occurs in a given zone —
 * "21:37 on 2026-08-05 in Asia/Kolkata" → a `Date`.
 *
 * The offset is applied twice on purpose. A zone's offset is itself a function of
 * the instant, so the first pass can only use the offset at the *wrong* instant;
 * across a DST boundary that lands an hour out. Re-reading the offset at the
 * corrected instant fixes it. The one case this cannot resolve is a wall-clock
 * time that does not exist — the hour spring-forward skips — where it returns the
 * adjacent real instant, which is the sane answer for a reminder.
 */
const zonedTimeToUtc = (dateString, minutesSinceMidnight, timeZone) => {
  const hh = String(Math.floor(minutesSinceMidnight / 60)).padStart(2, "0");
  const mm = String(minutesSinceMidnight % 60).padStart(2, "0");
  const asIfUtc = Date.parse(`${dateString}T${hh}:${mm}:00Z`);

  const firstPass = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
  return new Date(asIfUtc - zoneOffsetMs(new Date(firstPass), timeZone));
};

/** `YYYY-MM-DD` shifted by whole days, without touching a calendar library. */
const addDays = (dateString, days) =>
  new Date(Date.parse(`${dateString}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** An IANA zone Intl actually recognises — a browser can send anything. */
const isValidTimeZone = (timeZone) => {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

module.exports = {
  localDateString,
  localMinutesSinceMidnight,
  startOfLocalDay,
  zoneOffsetMs,
  zonedTimeToUtc,
  addDays,
  isValidTimeZone,
};
