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
const record = ({ model, feature, promptTokens, completionTokens }) => {
  const safe = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);

  AiUsage.updateOne(
    { day: dayKey(), model: model || "unknown", feature: feature || "unknown" },
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
 *
 * ## Why the model decides the rate
 *
 * Reading a receipt costs multiples of parsing a sentence — roughly ₹2 against
 * ₹0.15 (docs/10-AI-ASSISTANT.md §7) — so a single blended rate would make the
 * expensive half invisible inside the cheap half's volume. Since buckets are
 * already keyed on `{ day, model }`, costing per bucket is free: each is priced at
 * the rate for what actually ran.
 *
 * An unrecognised model falls back to the text rates. That is the safer default of
 * the two: it under-reports a vision bill rather than inflating an ordinary one,
 * and the vision model is a config value an operator sets deliberately.
 */
const ratesFor = (model) =>
  model && config.ai.visionModel && model === config.ai.visionModel
    ? { in: config.ai.visionPricePerMTokIn, out: config.ai.visionPricePerMTokOut }
    : { in: config.ai.pricePerMTokIn, out: config.ai.pricePerMTokOut };

const costOf = ({ promptTokens = 0, completionTokens = 0, model = null }) => {
  const rates = ratesFor(model);
  if (!rates.in && !rates.out) return null;

  return (promptTokens / 1_000_000) * rates.in + (completionTokens / 1_000_000) * rates.out;
};

/**
 * Adds costs that may individually be null.
 *
 * `null` means "no price configured", which is not zero — but a month containing
 * one priced model and one unpriced one does have a known partial cost, and
 * reporting null for the whole month because a single bucket lacks a rate would
 * hide the spend that *is* known. So nulls are skipped, and the total is null only
 * when nothing at all could be priced.
 */
const sumCosts = (costs) => {
  const known = costs.filter((cost) => cost !== null);
  return known.length === 0 ? null : known.reduce((sum, cost) => sum + cost, 0);
};

/**
 * This month's spend, and what is left of the budget.
 *
 * The day buckets are strings, so the month is a prefix match — no date range, no
 * timezone arithmetic, and the index on `day` serves it.
 */
const summary = async ({ month: requested } = {}) => {
  /**
   * Any month, not only this one.
   *
   * The whole point of letting the meter run for a month
   * (docs/22-MONETIZATION.md §14 step 5) is reading a *complete* month afterwards
   * — and on the 3rd of September, "this month" is three days of data that would
   * price a tier off a long weekend.
   *
   * Validated against the shape rather than trusted: it is interpolated into a
   * regex, and `^` or `.*` from a caller would turn a prefix match into a scan of
   * everything.
   */
  const month = /^\d{4}-\d{2}$/.test(String(requested || "")) ? String(requested) : monthKey();

  const buckets = await AiUsage.find({ day: { $regex: `^${month}` } })
    .select("day model feature calls promptTokens completionTokens")
    .lean();

  const totals = buckets.reduce(
    (sum, bucket) => ({
      calls: sum.calls + (bucket.calls || 0),
      promptTokens: sum.promptTokens + (bucket.promptTokens || 0),
      completionTokens: sum.completionTokens + (bucket.completionTokens || 0),
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0 }
  );

  /**
   * Costed per bucket and then added, never by costing the summed tokens.
   *
   * A bucket is one model's day, and models are priced differently — so summing
   * first and applying one rate would charge a month of receipt scans at the text
   * rate, or the reverse. This is the whole reason `model` is part of the key.
   */
  const cost = sumCosts(buckets.map(costOf));
  const { monthlyBudget, costCurrency } = config.ai;

  /**
   * A per-day series for the trend, oldest first and only for days that exist.
   *
   * Zero-filling absent days is the caller's business — a sparse series is the
   * truth, and a chart that wants a flat line for a quiet Sunday can add it.
   */
  const byDay = Object.values(
    buckets.reduce((days, bucket) => {
      const entry = days[bucket.day] || {
        day: bucket.day,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        // Collected before the day's models are merged, so each is priced at its
        // own rate and the day's cost is the sum.
        costs: [],
      };
      entry.calls += bucket.calls || 0;
      entry.promptTokens += bucket.promptTokens || 0;
      entry.completionTokens += bucket.completionTokens || 0;
      entry.costs.push(costOf(bucket));
      days[bucket.day] = entry;
      return days;
    }, {})
  )
    .map(({ costs, ...entry }) => ({ ...entry, cost: sumCosts(costs) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  /**
   * Which models ran this month, and what each cost.
   *
   * The line that answers "is receipt scanning worth what it costs", which is the
   * question §14 of docs/22 says has to be answerable before anything is priced. A
   * single monthly total cannot answer it; this can.
   */
  const byModel = Object.values(
    buckets.reduce((models, bucket) => {
      const entry = models[bucket.model] || {
        model: bucket.model,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
      };
      entry.calls += bucket.calls || 0;
      entry.promptTokens += bucket.promptTokens || 0;
      entry.completionTokens += bucket.completionTokens || 0;
      models[bucket.model] = entry;
      return models;
    }, {})
  )
    .map((entry) => ({
      ...entry,
      cost: costOf(entry),
      /** What one call averaged — the per-use figure a price would be set from. */
      costPerCall: entry.calls > 0 && costOf(entry) !== null ? costOf(entry) / entry.calls : null,
    }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

  /**
   * Per **feature**, which is the breakdown a price is actually set from.
   *
   * A receipt scan and a Ria question are different products with different
   * volumes, and only one of them is sold per use. Costed per bucket first — a
   * feature can legitimately span two models, as receipt scanning would the day a
   * cheaper vision model is tried alongside the current one.
   */
  const byFeature = Object.values(
    buckets.reduce((features, bucket) => {
      const key = bucket.feature || "unknown";
      const entry = features[key] || {
        feature: key,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costs: [],
        models: new Set(),
      };

      entry.calls += bucket.calls || 0;
      entry.promptTokens += bucket.promptTokens || 0;
      entry.completionTokens += bucket.completionTokens || 0;
      entry.costs.push(costOf(bucket));
      entry.models.add(bucket.model);
      features[key] = entry;
      return features;
    }, {})
  )
    .map(({ costs, models, ...entry }) => {
      const cost = sumCosts(costs);

      return {
        ...entry,
        models: [...models],
        cost,
        /**
         * The number §1.4 is waiting for: what one use of this feature costs. A
         * per-use price is this, plus a margin; a bundled allowance is this times
         * however many are included.
         */
        costPerCall: entry.calls > 0 && cost !== null ? cost / entry.calls : null,
      };
    })
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

  return {
    month,
    model: config.ai.model,
    visionModel: config.ai.visionModel || null,
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
    byModel,
    byFeature,
    /**
     * Whether this month is over.
     *
     * §14 step 5 is "a month of real cost data, then price", and the commonest way
     * to get that wrong is to read a month that is still happening — six days of
     * September look like a collapse in usage rather than like six days. The card
     * says so rather than leaving somebody to notice the date.
     */
    isComplete: month < monthKey(),
    months: await availableMonths(),
  };
};

/**
 * Every month the meter has anything for, newest first.
 *
 * A `distinct` on the day keys rather than a stored index of months: buckets are
 * one document per day per model per feature, so this is a small set, and a
 * separate months collection would be a second thing to keep in step with the
 * first for no gain.
 */
const availableMonths = async () => {
  const days = await AiUsage.distinct("day");
  return [...new Set(days.map((day) => String(day).slice(0, 7)))].sort().reverse();
};

module.exports = { record, summary, dayKey, monthKey, costOf, sumCosts, ratesFor, availableMonths };
