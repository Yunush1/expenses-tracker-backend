const { z } = require("zod");

/**
 * Shape only, and deliberately loose about the image itself.
 *
 * Whether the payload is a plausible photograph — the right MIME type, big enough
 * to read, small enough to send — is decided by `receiptScan.validateImage`, which
 * runs in the service *before* the group's scan allowance is claimed. Putting a
 * size rule here as well would be a second bound to keep in step with
 * `AI_MAX_IMAGE_BYTES`, and the two would eventually disagree about which photos
 * are acceptable.
 *
 * The cap here is a crude ceiling on the string, so a body that is obviously
 * absurd is rejected before anything reads it. Base64 inflates by a third, so this
 * sits comfortably above the byte limit rather than tracking it.
 */
const scanReceiptSchema = z.object({
  /** A `data:image/...;base64,...` URL. See receiptScan.validateImage. */
  image: z
    .string()
    .min(64, "No photo was attached")
    .max(12_000_000, "That photo is too large"),
});

module.exports = { scanReceiptSchema };
