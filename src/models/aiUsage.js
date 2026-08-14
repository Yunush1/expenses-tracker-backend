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

// One bucket per day per model, and the upsert depends on it being unique.
aiUsageSchema.index({ day: 1, model: 1 }, { unique: true });

module.exports = mongoose.model("AiUsage", aiUsageSchema);
