const AiUsage = require("../../models/aiUsage");
const config = require("../../config/env");
const logger = require("../../utils/logger");

/**
 * The assistant's meter: tokens in, money out, spend against a budget.
 *
 * ## What is exact and what is not — the distinction that matters
 *
 * **Tokens are exact.** Every provider response carries a `usage` block and
 * aiProvider records it, so the token counts here are what was actually billed.
 *
 * **Money is an estimate.** Nothing behind the OpenAI-compatible router exposes a
 * dependable credits-remaining endpoint, so cost is derived from the two rates in
 * `config.ai` — and it is only ever as right as those rates. When a rate is unset
 * the cost is reported as null rather than zero, because "no price configured" and
 * "free" are different facts and a dashboard that conflates them will be believed.
 *
 * `costEstimated: true` rides along on every response so the UI is obliged to say so.
 */

/** UTC, so a bucket does not depend on where the server happens to be. */
const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);

/** `YYYY-MM` for the current month, in the same timezone as the day keys. */
const monthKey = (date = new Date()) => date.toISOString().slice(0, 7);

/**
 * Add one call to today's bucket.
 *
 * Fire and forget, and never allowed to throw — see the note at the call site in
 * aiProvider. `upsert` with `$inc` makes it a single atomic round trip with no
 * read-modify-write, so concurrent calls cannot lose counts.
 */
const record = ({ model, promptTokens, completionTokens }) => {
  const safe = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);

  AiUsage.updateOne(
    { day: dayKey(), model: model || "unknown" },
    {
      $inc: {
        calls: 1,
        promptTokens: safe(promptTokens),
        completionTokens: safe(completionTokens),
      },
    },
    { upsert: true }
  ).catch((err) => logger.warn(`[ai] Could not record usage: ${err.message}`));
};

/**
 * Cost of one bucket, or null when there is no price to apply.
 *
 * Rates are per million tokens because that is how every provider quotes them —
 * converting to per-token here would bury a factor of a million in a constant.
 */
const costOf = ({ promptTokens = 0, completionTokens = 0 }) => {
  const { pricePerMTokIn, pricePerMTokOut } = config.ai;
  if (!pricePerMTokIn && !pricePerMTokOut) return null;

  return (
    (promptTokens / 1_000_000) * pricePerMTokIn +
    (completionTokens / 1_000_000) * pricePerMTokOut
  );
};

/**
 * This month's spend, and what is left of the budget.
 *
 * The day buckets are strings, so the month is a prefix match — no date range, no
 * timezone arithmetic, and the index on `day` serves it.
 */
const summary = async () => {
  const month = monthKey();
  const buckets = await AiUsage.find({ day: { $regex: `^${month}` } })
    .select("day model calls promptTokens completionTokens")
    .lean();

  const totals = buckets.reduce(
    (sum, bucket) => ({
      calls: sum.calls + (bucket.calls || 0),
      promptTokens: sum.promptTokens + (bucket.promptTokens || 0),
      completionTokens: sum.completionTokens + (bucket.completionTokens || 0),
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0 }
  );

  const cost = costOf(totals);
  const { monthlyBudget, costCurrency } = config.ai;

  /**
   * A per-day series for the trend, oldest first and only for days that exist.
   *
   * Zero-filling absent days is the caller's business — a sparse series is the
   * truth, and a chart that wants a flat line for a quiet Sunday can add it.
   */
  const byDay = Object.values(
    buckets.reduce((days, bucket) => {
      const entry = days[bucket.day] || { day: bucket.day, calls: 0, promptTokens: 0, completionTokens: 0 };
      entry.calls += bucket.calls || 0;
      entry.promptTokens += bucket.promptTokens || 0;
      entry.completionTokens += bucket.completionTokens || 0;
      days[bucket.day] = entry;
      return days;
    }, {})
  )
    .map((entry) => ({ ...entry, cost: costOf(entry) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    month,
    model: config.ai.model,
    currency: costCurrency,
    calls: totals.calls,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.promptTokens + totals.completionTokens,
    /** Null when no rates are configured — see the note at the top of this file. */
    cost,
    /** Always true when `cost` is a number. It is derived, never billed. */
    costEstimated: cost !== null,
    budget: monthlyBudget || null,
    /**
     * What the question actually asked: how much is left.
     *
     * Null unless both a budget and a price exist, because either one missing makes
     * the answer unknowable — and floored at zero, since a budget can be exceeded
     * but "negative credit remaining" is not a thing anybody wants to read.
     */
    remaining: monthlyBudget && cost !== null ? Math.max(0, monthlyBudget - cost) : null,
    percentUsed:
      monthlyBudget && cost !== null ? Math.min(100, Math.round((cost / monthlyBudget) * 100)) : null,
    byDay,
  };
};

module.exports = { record, summary, dayKey, monthKey, costOf };
