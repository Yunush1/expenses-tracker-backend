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
});

module.exports = { registerTokenSchema };
