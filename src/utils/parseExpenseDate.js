/**
 * "yesterday", "last Friday", "25 July" → a real date.
 *
 * ## Why this is not left to the model
 *
 * Working out that "last Friday" was the 1st requires knowing today, knowing what
 * day it falls on, and counting backwards — three chances to be confidently
 * wrong, in a field that decides which month an expense lands in and therefore
 * which monthly total it moves. A language model will get it right most of the
 * time, and "most of the time" is not a standard a ledger can be held to.
 *
 * So the phrase is parsed here, deterministically, from the words the user
 * actually typed. The model's own answer is kept as a fallback for the cases this
 * does not cover ("the day we flew back"), and it is validated before use.
 *
 * The same division as everywhere else in the assistant: the model is allowed to
 * be wrong about what someone *said*; it is not allowed to be wrong about what
 * ends up in the ledger (docs/10-AI-ASSISTANT.md §11).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

/** Midnight, so a date is a day rather than an instant. */
const atMidnight = (date) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const iso = (date) => {
  const copy = atMidnight(date);
  return `${copy.getFullYear()}-${String(copy.getMonth() + 1).padStart(2, "0")}-${String(
    copy.getDate()
  ).padStart(2, "0")}`;
};

/**
 * Phrases that name a period but not a day.
 *
 * "I forgot to add last month's fuel" says *when-ish* and not *when*. Guessing a
 * day inside that month would put the expense on a date the user never chose, in
 * a monthly total they will later query — so these resolve to nothing and ask.
 */
const VAGUE = [
  /\blast month\b/i,
  /\blast week\b/i,
  /\bthis month\b/i,
  /\bearlier this (?:month|week|year)\b/i,
  /\ba (?:while|few days) (?:ago|back)\b/i,
  /\bsome time (?:ago|back)\b/i,
  /\brecently\b/i,
  /\blast year\b/i,
];

/**
 * Parse a date out of free text.
 *
 * @returns `{ date, source }` when a day is identified, `{ vague: true }` when a
 *   period is named without a day, or null when no date is mentioned at all.
 */
const parseExpenseDate = (text, now = new Date()) => {
  const message = String(text || "").toLowerCase();
  if (!message.trim()) return null;

  const today = atMidnight(now);

  /* --------------------------- explicit ISO --------------------------- */

  const isoMatch = message.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const parsed = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    if (!Number.isNaN(parsed.getTime())) return { date: parsed, source: "iso" };
  }

  /* ------------------------------ relative ----------------------------- */

  if (/\bday before yesterday\b/i.test(message)) {
    return { date: new Date(today.getTime() - 2 * DAY_MS), source: "relative" };
  }
  if (/\byesterday\b/i.test(message)) {
    return { date: new Date(today.getTime() - DAY_MS), source: "relative" };
  }
  if (/\b(?:today|tonight|just now|this morning|this afternoon|this evening)\b/i.test(message)) {
    return { date: today, source: "relative" };
  }

  const daysAgo = message.match(/\b(\d{1,3})\s+days?\s+(?:ago|back)\b/i);
  if (daysAgo) {
    const n = Number(daysAgo[1]);
    if (n > 0 && n <= 730) return { date: new Date(today.getTime() - n * DAY_MS), source: "relative" };
  }

  /* ------------------------------ weekdays ----------------------------- */

  const weekday = message.match(
    /\b(?:last|past|this)?\s*(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i
  );
  if (weekday) {
    const target = WEEKDAYS[weekday[1].toLowerCase()];
    const current = today.getDay();

    /**
     * Always the most recent one that has already happened.
     *
     * "Friday dinner" said on a Wednesday means the Friday just gone, not the one
     * coming — an expense is a thing that already happened. Saying it *on* Friday
     * means today, which is why the offset falls through to 0 rather than 7.
     */
    let back = (current - target + 7) % 7;
    if (back === 0 && /\blast\b/i.test(message)) back = 7;

    return { date: new Date(today.getTime() - back * DAY_MS), source: "weekday" };
  }

  /* --------------------------- day and month --------------------------- */

  const monthNames = Object.keys(MONTHS).join("|");

  // "25 July", "25th July", "2 aug 2025"
  const dayFirst = message.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\b(?:\\s+(\\d{4}))?`, "i")
  );
  // "July 25", "Jul 25th 2025"
  const monthFirst = message.match(
    new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i")
  );

  const explicit = dayFirst
    ? { day: Number(dayFirst[1]), month: MONTHS[dayFirst[2].toLowerCase()], year: dayFirst[3] }
    : monthFirst
      ? { day: Number(monthFirst[2]), month: MONTHS[monthFirst[1].toLowerCase()], year: monthFirst[3] }
      : null;

  if (explicit && explicit.day >= 1 && explicit.day <= 31) {
    /**
     * No year given means the most recent occurrence.
     *
     * "25 December" said in January is last year's Christmas, not one eleven
     * months away — an expense is in the past, so a date that would land in the
     * future rolls back a year.
     */
    let year = explicit.year ? Number(explicit.year) : today.getFullYear();
    let candidate = new Date(year, explicit.month, explicit.day);

    if (!explicit.year && candidate.getTime() > today.getTime() + DAY_MS) {
      year -= 1;
      candidate = new Date(year, explicit.month, explicit.day);
    }

    // Rejects "31 February", which JS would silently roll into March.
    if (candidate.getMonth() === explicit.month && candidate.getDate() === explicit.day) {
      return { date: candidate, source: "calendar" };
    }
  }

  /* -------------------------- named but vague -------------------------- */

  if (VAGUE.some((pattern) => pattern.test(message))) return { vague: true };

  return null;
};

/**
 * How far back a date is allowed to be.
 *
 * Two years covers a forgotten receipt from a trip; beyond that it is far more
 * likely to be a mistyped year than a genuine entry, and an expense dated 2015
 * disappears from every month view without ever looking wrong.
 */
const MAX_AGE_MS = 2 * 365 * DAY_MS;

/**
 * The date an expense should carry, and whether to ask about it.
 *
 * Order of trust: what the words say (parsed here) → what the model returned →
 * today.
 */
const resolveExpenseDate = ({ text, modelDate, now = new Date() }) => {
  const today = atMidnight(now);
  const parsed = parseExpenseDate(text, now);

  if (parsed?.date) {
    return { date: iso(parsed.date), needsConfirmation: false, source: parsed.source };
  }

  /**
   * A period was named but no day. The expense still gets today's date so the
   * draft is usable, and the card says so — an unanswerable "when was it?" that
   * blocks the whole entry is worse than a visible default.
   */
  if (parsed?.vague) {
    return { date: iso(today), needsConfirmation: true, source: "vague" };
  }

  if (modelDate) {
    const candidate = new Date(`${String(modelDate).slice(0, 10)}T00:00:00`);
    const valid =
      !Number.isNaN(candidate.getTime()) &&
      candidate.getTime() <= today.getTime() + DAY_MS &&
      candidate.getTime() >= today.getTime() - MAX_AGE_MS;

    // Only trusted when it disagrees with today — a model echoing today's date
    // tells us nothing, and treating that as a finding would hide a real miss.
    if (valid) {
      return { date: iso(candidate), needsConfirmation: false, source: "model" };
    }
  }

  return { date: iso(today), needsConfirmation: false, source: "default" };
};

module.exports = { parseExpenseDate, resolveExpenseDate, iso };
