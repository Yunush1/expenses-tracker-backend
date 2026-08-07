/**
 * Natural-language expense dates.
 *
 *   node scripts/check-expense-date.js
 *
 * No database and no AI provider — this is pure date arithmetic, which is exactly
 * why it is parsed deterministically rather than left to the model.
 */
require("../src/config/env");

const { parseExpenseDate, resolveExpenseDate, iso } = require("../src/utils/parseExpenseDate");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

// A fixed "today" so the expectations are stable: Wednesday 6 August 2025.
const NOW = new Date(2025, 7, 6, 14, 30);
const on = (text) => {
  const result = parseExpenseDate(text, NOW);
  return result?.date ? iso(result.date) : result?.vague ? "VAGUE" : null;
};

console.log(`today is ${iso(NOW)} (a Wednesday)\n`);

console.log("--- the examples from the spec ---");
check('"Yesterday I spent 500"', on("Yesterday I spent 500"), "2025-08-05");
check('"Last Friday dinner 1200"', on("Last Friday dinner 1200"), "2025-08-01");
check('"On 25 July groceries 1800"', on("On 25 July groceries 1800"), "2025-07-25");
check(
  '"I forgot to add last month\'s fuel 2500" → vague',
  on("I forgot to add last month's fuel 2500"),
  "VAGUE"
);
check("no date mentioned → nothing parsed", on("add 500 for dinner"), null);

console.log("\n--- relative ---");
check('"today"', on("add 300 today"), "2025-08-06");
check('"tonight"', on("dinner tonight 800"), "2025-08-06");
check('"day before yesterday"', on("day before yesterday 200"), "2025-08-04");
check('"3 days ago"', on("fuel 900 3 days ago"), "2025-08-03");
check('"10 days back"', on("10 days back groceries"), "2025-07-27");

console.log("\n--- weekdays resolve backwards, never forwards ---");
check('"last friday" (5 days back)', on("last friday"), "2025-08-01");
check('"monday" (2 days back)', on("monday lunch"), "2025-08-04");
check('"tuesday" (1 day back)', on("tuesday"), "2025-08-05");
check('"wednesday" = today, not next week', on("wednesday"), "2025-08-06");
check('"last wednesday" = a week ago', on("last wednesday"), "2025-07-30");
check('"thursday" (6 days back, not tomorrow)', on("thursday"), "2025-07-31");

console.log("\n--- calendar dates ---");
check('"25 July"', on("25 july groceries"), "2025-07-25");
check('"25th July"', on("25th july"), "2025-07-25");
check('"2 august"', on("2 august fuel"), "2025-08-02");
check('"July 25"', on("july 25 groceries"), "2025-07-25");
check('"Aug 2 2024" honours the year', on("aug 2 2024 fuel"), "2024-08-02");
check("an ISO date is taken as-is", on("on 2025-03-14 dinner"), "2025-03-14");

console.log("\n--- a date with no year means the most recent one ---");
// December has not happened yet in 2025, so it must be 2024's.
check('"25 December" in August → last year', on("25 december gifts"), "2024-12-25");
check('"2 august" today-ish → this year', on("2 august"), "2025-08-02");

console.log("\n--- impossible dates are refused, not rolled over ---");
check('"31 February" is not 3 March', on("31 february"), null);
check('"32 January" is not parsed', on("32 january"), null);

console.log("\n--- vague periods do not become a guessed day ---");
["last month", "last week", "this month", "a while ago", "recently", "last year"].forEach((phrase) =>
  check(`"${phrase}"`, on(`${phrase} fuel 900`), "VAGUE")
);

console.log("\n--- resolve: words beat the model, and the model is bounded ---");
const resolve = (text, modelDate) => resolveExpenseDate({ text, modelDate, now: NOW });

check(
  "the message wins over a disagreeing model",
  resolve("yesterday dinner", "2025-01-01").date,
  "2025-08-05"
);
check(
  "the model is used when the words say nothing",
  resolve("dinner with the team", "2025-07-04").date,
  "2025-07-04"
);
check(
  "a future date from the model is refused",
  resolve("dinner", "2099-01-01").date,
  iso(NOW)
);
check(
  "a date older than two years is refused",
  resolve("dinner", "2015-01-01").date,
  iso(NOW)
);
check("garbage from the model is refused", resolve("dinner", "not-a-date").date, iso(NOW));
check("no date anywhere → today", resolve("add 500 for dinner", null).date, iso(NOW));

console.log("\n--- vague wording asks rather than guessing ---");
const vague = resolve("add last month's fuel 2500", null);
check("still usable — dated today", vague.date, iso(NOW));
check("but flagged for confirmation", vague.needsConfirmation, true);

const certain = resolve("yesterday fuel 2500", null);
check("an unambiguous date is not flagged", certain.needsConfirmation, false);

console.log("\ndone");
