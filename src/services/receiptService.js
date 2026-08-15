const receiptScan = require("./ai/receiptScan");
const receiptStorage = require("../utils/receiptStorage");
const aiProvider = require("./ai/aiProvider");
const entitlementService = require("./entitlementService");
const { FEATURES, ERROR_CODES } = require("../constants");
const { BadRequestError, ServiceUnavailableError } = require("../errors");
const logger = require("../utils/logger");

/**
 * Receipt scanning, as the group pays for it
 * (docs/22-MONETIZATION.md §14 step 7, docs/10-AI-ASSISTANT.md §4.2).
 *
 * ## Why this is a group route and not an AI route
 *
 * Every other AI endpoint sits behind `requireAuth`, because they cost money per
 * call and an account is what a daily quota is counted against
 * (docs/10-AI-ASSISTANT.md §3). Receipt scanning breaks that pattern deliberately,
 * and the reasoning is docs/22 §1.1: a group is reachable by link with no account,
 * and putting a signup between a flatmate and a photograph of the groceries is
 * exactly the move that document says should be "rejected on sight".
 *
 * The cost control does not weaken — it changes shape. The bound here is the
 * **group's** monthly scan allowance, claimed atomically before the provider is
 * called. That is at least as strong as a per-account quota and arguably stronger:
 * an account quota is per person, so five flatmates are five quotas, while a group
 * allowance is one number for the thing being protected.
 *
 * ## The order of operations, which is the whole file
 *
 *   1. Is scanning configured at all?      → 503, nothing charged
 *   2. Is this a plausible image?          → 400, nothing charged
 *   3. Claim one scan from the group       → 403 when the allowance is gone
 *   4. Call the model
 *   5. On failure, hand the scan back
 *
 * Steps 1 and 2 sit above step 3 on purpose. Charging somebody a scan for
 * uploading a PDF, or for a deployment that never configured a vision model, would
 * be taking something for nothing.
 */

const scan = async ({ group, image }) => {
  if (!aiProvider.isVisionConfigured()) {
    /**
     * 503 rather than 404 or 500: the route is real and nothing has broken. An
     * operator needs to set `AI_VISION_MODEL` — the same posture Firebase and SMTP
     * take when they are unconfigured.
     */
    throw new ServiceUnavailableError(
      "Receipt scanning isn't switched on for this server. Adding expenses by hand works as always."
    );
  }

  const invalid = receiptScan.validateImage(image);
  if (invalid) throw new BadRequestError(invalid, ERROR_CODES.VALIDATION_ERROR);

  /**
   * Claim the scan. Throws `FEATURE_LIMIT_REACHED` or `FEATURE_LOCKED` with the
   * `details` the wall is drawn from — and the message says what always works,
   * because running out of scans must never stop an expense being added by hand
   * (docs/22 §8).
   */
  const entitlement = await entitlementService.consume(group, FEATURES.RECEIPT_SCAN);

  try {
    const result = await receiptScan.scanReceipt({ dataUrl: image, currency: group.currency });

    /**
     * Kept only once the model has answered, and only if it was a receipt.
     *
     * Storing before the call would leave a file behind for every failure and
     * every photograph of a cat, and those are exactly the ones nobody ever comes
     * back to delete. Writing it after means the disk only ever holds photos that
     * turned into something.
     *
     * Never awaited into the failure path: `save` swallows its own errors and
     * returns null, because a full disk must not turn a scan that has already been
     * paid for into an error. The numbers are the valuable part.
     */
    const imageUrl = result.isReceipt ? await receiptStorage.save(image) : null;

    return {
      ...result,
      /**
       * Where the photo now lives, or null when storage is switched off or failed.
       *
       * The client attaches it to the expenses it creates, so the paper sits
       * beside the numbers and a disputed line can be checked months later. The
       * URL is a capability — 128 random bits of filename — and is treated exactly
       * like an invite link: shareable, unguessable, and never enumerable.
       */
      imageUrl,
      /**
       * What is left, returned with the answer.
       *
       * So the UI can say "2 scans left this month" on the review screen rather
       * than at the wall, which is the only place it would otherwise appear — by
       * which point the number is zero and the sentence is a refusal.
       */
      scansLeft: entitlement.remaining,
      resetsOn: entitlement.limits.resetsOn,
    };
  } catch (error) {
    /**
     * The provider failed, timed out, or returned something unreadable. The group
     * gets its scan back: they have nothing to show for it, and charging for a
     * failure teaches people not to use the feature.
     *
     * Note what is *not* refunded — a photograph that was read successfully and
     * turned out not to be a receipt. That call happened and the bill for it is
     * real, and a free retry on "not a receipt" is a free vision call for anybody
     * who wants one.
     */
    await entitlementService.refund(group, FEATURES.RECEIPT_SCAN);

    logger.warn(`[receipt] Scan failed for group ${group._id}, refunded: ${error.message}`);

    throw new ServiceUnavailableError(
      error.permanent
        ? "Receipt scanning isn't available right now. Add the expense by hand — that always works."
        : "Couldn't read that one. Try a clearer photo, or add it by hand.",
      ERROR_CODES.FEATURE_UNAVAILABLE
    );
  }
};

module.exports = { scan };
