const { z } = require("zod");

/**
 * FCM registration tokens are opaque, vendor-controlled strings with no published
 * format, so the bound is a sanity check rather than a grammar: long enough that a
 * stray empty string is rejected, loose enough to survive Google changing the
 * shape. Real tokens sit around 160 characters.
 */
const registerTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, "That does not look like a push token")
    .max(4096, "Push token is too long"),
  /**
   * The browser's IANA zone, so the evening reminder lands in the evening.
   * Optional — a browser that will not say falls back to the configured default,
   * and the value is re-checked against Intl server-side before it is trusted.
   */
  timeZone: z.string().trim().max(64).optional(),
});

const preferencesSchema = z.object({
  dailyNudge: z.boolean(),
});

module.exports = { registerTokenSchema, preferencesSchema };
