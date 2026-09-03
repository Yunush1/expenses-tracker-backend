const crypto = require("crypto");

const ShareLink = require("../models/shareLink");
const { LIMITS, ERROR_CODES } = require("../constants");
const { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } = require("../errors");
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
 *
 * The owner's hash goes in too, when there is one. That is what stops two people
 * who typed the same trip from sharing a row — which used to be a harmless saving
 * and became a bug the moment a row could be edited, because one of them editing
 * would rewrite the other's link. Omitted when there is no owner, so every row
 * written before this keeps the fingerprint it already has.
 */
const fingerprintOf = (kind, payload, ownerKeyHash = null) =>
  crypto
    .createHash("sha256")
    .update(ownerKeyHash ? `${kind}:${payload}:${ownerKeyHash}` : `${kind}:${payload}`)
    .digest("hex");

/** Only ever the hash is stored — see models/shareLink.js. */
const hashOwnerKey = (ownerKey) =>
  crypto.createHash("sha256").update(String(ownerKey)).digest("hex");

/**
 * Constant-time comparison, because this is the one check standing between a
 * stranger and somebody else's link. Both sides are 64 hex characters, so the
 * length guard never fires in practice and is there so `timingSafeEqual` cannot
 * throw on input that did not come from `hashOwnerKey`.
 */
const sameOwner = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

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
 * returns the same code rather than a second row.
 *
 * `ownerKey` is the client's own secret and is optional. With one, the caller can
 * come back and change what this code stands for; without, the row behaves
 * exactly as every row did before — fixed for the life of the link.
 */
exports.create = async ({ kind, payload, ownerKey = null }) => {
  const ownerKeyHash = ownerKey ? hashOwnerKey(ownerKey) : null;
  const fingerprint = fingerprintOf(kind, payload, ownerKeyHash);

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
        ownerKeyHash,
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
 * Replace what a code stands for, for the client that made it.
 *
 * The link in somebody's chat is unchanged; what it resolves to is not. That is
 * the whole feature: the alternative was sending a second link and hoping
 * everybody reads the newer message.
 *
 * Refuses rather than creating: a code that does not exist, or one this caller
 * cannot prove it made, is not something to quietly mint a replacement for. The
 * client decides what to do about that, and what it does is start a fresh link.
 */
exports.update = async ({ code, payload, ownerKey }) => {
  const link = await ShareLink.findOne({ code });

  if (!link) {
    throw new NotFoundError(
      "That link has expired or was copied incompletely. Ask for a fresh one.",
      ERROR_CODES.SHARE_LINK_NOT_FOUND
    );
  }

  /**
   * Unowned links are immutable, and that is not a gap to close later. They were
   * shared under a promise that a code means one calculation for ever, and the
   * people holding them never agreed to anything else.
   */
  if (!link.ownerKeyHash || !sameOwner(link.ownerKeyHash, hashOwnerKey(ownerKey))) {
    throw new ForbiddenError(
      "This link was made somewhere else, so it cannot be updated from here.",
      ERROR_CODES.SHARE_LINK_NOT_YOURS
    );
  }

  // Nothing to say. The clock still moves — asking to update a link is evidence
  // it is still wanted, exactly as sharing it again is.
  if (link.payload === payload) {
    link.expiresAt = nextExpiry();
    await link.save();
    return { code: link.code, kind: link.kind, changed: false, updatedAt: link.updatedAt };
  }

  link.payload = payload;
  link.fingerprint = fingerprintOf(link.kind, payload, link.ownerKeyHash);
  link.expiresAt = nextExpiry();

  try {
    await link.save();
  } catch (error) {
    /**
     * The fingerprint carries this row's own owner hash, so the only row that
     * could collide is one this same owner already has holding this exact
     * payload. Vanishingly unlikely, and a 409 the client can read beats the 500
     * an unhandled duplicate key becomes.
     */
    if (error?.code === 11000) {
      throw new ConflictError("You already have a link for this exact calculation.");
    }
    throw error;
  }

  return { code: link.code, kind: link.kind, changed: true, updatedAt: link.updatedAt };
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
