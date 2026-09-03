const crypto = require("crypto");

const ShareLink = require("../models/shareLink");
const { LIMITS, ERROR_CODES } = require("../constants");
const { ConflictError, NotFoundError, ServiceUnavailableError } = require("../errors");
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
 * `kind` and `code` are both inside it. `kind` so two kinds that ever share an
 * encoding cannot collide; `code` so the hash is unique per row and dedupes
 * nothing — see models/shareLink.js for why content dedupe had to go once rows
 * became editable.
 */
const fingerprintOf = (kind, code, payload) =>
  crypto.createHash("sha256").update(`${kind}:${code}:${payload}`).digest("hex");

/**
 * How many times to try again when a generated code is already taken.
 *
 * At 62^7 a collision is a lottery win, so this is not a retry strategy so much
 * as a refusal to lose a link to one. Three attempts turns "astronomically
 * unlikely" into "not worth a second thought".
 */
const CODE_ATTEMPTS = 3;

/**
 * Create a short link.
 *
 * No longer idempotent by content, and that is the point: two people who happen
 * to have typed the same trip must not be handed one shared document that either
 * can rewrite. Pressing Share twice on the *same* calculation still yields one
 * link, because the client remembers the code it was given and updates that
 * instead of asking for another.
 */
exports.create = async ({ kind, payload }) => {
  for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
    const code = generateShareCode();

    try {
      const link = await ShareLink.create({
        code,
        kind,
        payload,
        fingerprint: fingerprintOf(kind, code, payload),
        revision: 1,
        expiresAt: nextExpiry(),
      });

      return { code: link.code, kind: link.kind, revision: link.revision };
    } catch (error) {
      if (error?.code !== 11000) throw error;

      // A generated code was already taken. Draw another and go round — at 62^7
      // this is a lottery win rather than something to plan around.
      logger.warn(`[share-link] code collision on attempt ${attempt}`);
    }
  }

  throw new ServiceUnavailableError("Could not create a share link. Please try again.");
};

/**
 * Replace what a code stands for. Anybody holding the code may do this.
 *
 * The link in the chat is unchanged; what it resolves to is not. Everyone the
 * link reached is a writer, because the normal response to a shared trip is "you
 * forgot the taxi" and the person who noticed should be able to add it.
 *
 * `revision` is the copy this edit was based on. A mismatch means somebody saved
 * in between, and the write is refused rather than applied — the client then
 * fetches what it missed and decides. Without that, whoever typed second would
 * silently erase whoever typed first, which is the failure nobody would ever spot
 * in time.
 *
 * Refuses rather than creating: an unknown code is not something to quietly mint
 * a replacement for. The client's answer to that is a fresh link.
 */
exports.update = async ({ code, payload, revision }) => {
  const link = await ShareLink.findOne({ code });

  if (!link) {
    throw new NotFoundError(
      "That link has expired or was copied incompletely. Ask for a fresh one.",
      ERROR_CODES.SHARE_LINK_NOT_FOUND
    );
  }

  /**
   * The check is skipped when the caller states no revision, which is how an
   * older client — one deployed before any of this — goes on working. It gets
   * last-write-wins, which is what it already had.
   */
  if (revision != null && revision !== link.revision) {
    throw new ConflictError(
      "Somebody else saved a change first. Reload to see it before saving yours.",
      ERROR_CODES.SHARE_LINK_CONFLICT
    );
  }

  // Nothing to say, so nothing is written and the revision does not move — a
  // no-op that bumped it would make every other client think it was behind. The
  // clock still moves: asking to save is evidence the link is still wanted.
  if (link.payload === payload) {
    link.expiresAt = nextExpiry();
    await link.save();
    return {
      code: link.code,
      kind: link.kind,
      revision: link.revision,
      changed: false,
      updatedAt: link.updatedAt,
    };
  }

  link.payload = payload;
  link.fingerprint = fingerprintOf(link.kind, link.code, payload);
  link.revision = link.revision + 1;
  link.expiresAt = nextExpiry();
  await link.save();

  return {
    code: link.code,
    kind: link.kind,
    revision: link.revision,
    changed: true,
    updatedAt: link.updatedAt,
  };
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

  /**
   * `revision` travels with the payload because the two are one fact: a client
   * that reads a payload and then saves has to say which copy it changed, and
   * fetching that separately would leave a window where it states a revision it
   * never actually read.
   */
  return {
    kind: link.kind,
    payload: link.payload,
    revision: link.revision,
    updatedAt: link.updatedAt,
  };
};
