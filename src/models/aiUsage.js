const mongoose = require("mongoose");

/**
 * What the assistant has cost, one document per day per model.
 *
 * ## Why an aggregate and not a row per call
 *
 * A row per call would grow without bound for a figure nobody reads per-call, and
 * every read of "this month's spend" would become a scan. A daily bucket is one
 * atomic `$inc` per call, 365 documents a year, and still fine-grained enough to
 * draw a trend or spot the day something ran away.
 *
 * ## Why the model is part of the key
 *
 * Price follows the model, and the model is a config value that can change
 * mid-month (see config.ai.model — it has already changed once, from an 8B). Keying
 * on `{ day, model }` means a switch does not silently re-price everything that came
 * before it: each bucket is costed at the rate for what actually ran.
 *
 * ## What this deliberately does not hold
 *
 * No userId, no question, no prompt. This is a meter, not an audit log — it answers
 * "how much has been spent" and nothing about who asked what. The transcript already
 * exists for the user's own benefit in `aiMessage`, expires on its own, and is
 * clearable by them; duplicating any of it here would create a second, permanent
 * copy with none of those properties.
 */
const aiUsageSchema = new mongoose.Schema(
  {
    /** `YYYY-MM-DD` in UTC. A string, so a bucket is addressable without a range query. */
    day: {
      type: String,
      required: true,
    },
    model: {
      type: String,
      required: true,
    },
    /**
     * Which capability spent this — `ask`, `draft`, `receipt`, `suggestions`.
     *
     * ## Why the model is not enough
     *
     * Pricing needs "what does one receipt scan cost" and "what does one Ria
     * question cost" as separate numbers (docs/22-MONETIZATION.md §1.4). Receipt
     * scanning separates itself, because it runs on a different model — but Ria's
     * answers, her expense drafts and her starter suggestions all share the text
     * model, so a per-model total blends three features with very different
     * shapes and volumes. A tier priced off that blend would be priced off an
     * average nobody is.
     *
     * Rows written before this field existed read as `unknown`, which is honest
     * and needs no backfill: their tokens are still counted, they simply cannot
     * say which feature spent them.
     */
    feature: {
      type: String,
      required: true,
      default: "unknown",
    },
    calls: {
      type: Number,
      default: 0,
    },
    /**
     * Exact, as reported by the provider — unlike the money, which is derived from
     * configured rates. Prompt and completion are kept apart because they are
     * priced differently, usually by a factor of three or more.
     */
    promptTokens: {
      type: Number,
      default: 0,
    },
    completionTokens: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

/**
 * One bucket per day per model per feature, and the upsert depends on it being
 * unique.
 *
 * Widening this index is a migration in the mildest sense: the old two-field
 * unique index has to go, or the first two features to run on one model on one day
 * will collide on it. `scripts/migrate-ai-usage.js` drops it; until that runs, the
 * upsert's duplicate-key error is swallowed by `record`, which never throws — so
 * the failure mode is a few uncounted calls rather than a broken assistant.
 */
aiUsageSchema.index({ day: 1, model: 1, feature: 1 }, { unique: true });

module.exports = mongoose.model("AiUsage", aiUsageSchema);
