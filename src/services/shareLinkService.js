const crypto = require("crypto");

const ShareLink = require("../models/shareLink");
const { LIMITS, ERROR_CODES } = require("../constants");
const { NotFoundError, ServiceUnavailableError } = require("../errors");
const { generateShareCode } = require("../utils/shareCode");
const logger = require("../utils/logger");

/**
 * Short links for calculator state — see models/shareLink.js for what this costs
 * and why it is only reached from an explicit Copy or Share.
 */

const TTL_MS = LIMITS.SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000;

const nextExpiry = () => new Date(Date.now() + TTL_MS);

/**
 * The dedupe key.
 *
 * Hashed rather than indexed directly because the payload runs to thousands of
 * characters and Mongo's index-key limit is 1024 bytes — an index on the payload
 * itself would fail on exactly the large trips this feature is for.
 *
 * `kind` is inside the hash so two kinds that ever share an encoding do not
 * collapse into one row pointing at the wrong page.
 */
const fingerprintOf = (kind, payload) =>
  crypto.createHash("sha256").update(`${kind}:${payload}`).digest("hex");

/**
 * How many times to try again when a generated code is already taken.
 *
 * At 62^7 a collision is a lottery win, so this is not a retry strategy so much
 * as a refusal to lose a link to one. Three attempts turns "astronomically
 * unlikely" into "not worth a second thought".
 */
const CODE_ATTEMPTS = 3;

/**
 * Create a short link, or hand back the one this exact payload already has.
 *
 * Idempotent by content: pressing Copy, editing nothing, and pressing Copy again
 * returns the same code rather than a second row. Change a number and the payload
 * changes, so the code does too — the same snapshot semantics the fragment link
 * has always had.
 */
exports.create = async ({ kind, payload }) => {
  const fingerprint = fingerprintOf(kind, payload);

  /**
   * Reuse first, and refresh the clock while we are here: sharing a link again is
   * the strongest possible evidence it is still wanted.
   */
  const existing = await ShareLink.findOneAndUpdate(
    { fingerprint },
    { $set: { expiresAt: nextExpiry() } },
    { new: true }
  ).lean();

  if (existing) return { code: existing.code, kind: existing.kind, reused: true };

  for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
    try {
      const link = await ShareLink.create({
        code: generateShareCode(),
        kind,
        payload,
        fingerprint,
        expiresAt: nextExpiry(),
      });

      return { code: link.code, kind: link.kind, reused: false };
    } catch (error) {
      if (error?.code !== 11000) throw error;

      /**
       * Two identical payloads raced each other here. Both callers want the same
       * thing and one of them already has it, so read the winner rather than
       * failing the loser — from the outside both taps produced a link.
       */
      if (error?.keyPattern?.fingerprint) {
        const winner = await ShareLink.findOne({ fingerprint }).lean();
        if (winner) return { code: winner.code, kind: winner.kind, reused: true };
      }

      // Otherwise the code collided. Draw another and go round.
      logger.warn(`[share-link] code collision on attempt ${attempt}`);
    }
  }

  throw new ServiceUnavailableError("Could not create a share link. Please try again.");
};

/**
 * Resolve a code back to its payload.
 *
 * Pushes `expiresAt` forward in the same write, so a link stays alive for as long
 * as people keep opening it and only ages out once they stop.
 */
exports.resolve = async (code) => {
  const link = await ShareLink.findOneAndUpdate(
    { code },
    { $inc: { hits: 1 }, $set: { lastOpenedAt: new Date(), expiresAt: nextExpiry() } },
    { new: true }
  ).lean();

  if (!link) {
    /**
     * One message for expired, mistyped and truncated alike, because the server
     * genuinely cannot tell them apart — and because the reader's next step is
     * the same in all three: ask whoever sent it to send it again.
     */
    throw new NotFoundError(
      "That link has expired or was copied incompletely. Ask for a fresh one.",
      ERROR_CODES.SHARE_LINK_NOT_FOUND
    );
  }

  return { kind: link.kind, payload: link.payload };
};
