const mongoose = require("mongoose");

const { LIMITS, SHARE_LINK_KINDS } = require("../constants");
const { generateShareCode } = require("../utils/shareCode");

/**
 * A short stand-in for a calculator link.
 *
 * ## What this trades away, said plainly
 *
 * `/tools/group-expense-calculator` puts the whole calculation in the URL
 * fragment, and utils/shareState.js makes a strong claim about that: everything
 * after `#` is never transmitted, so nothing anyone types is sent anywhere, even
 * for a link that has been shared. This collection is the exception to that
 * sentence. A short link cannot be short and self-contained at the same time —
 * something has to hold the payload, and here it is a row on our disk.
 *
 * So the two links are kept as two different things rather than one replacing the
 * other:
 *
 *  - The **address bar** stays the fragment link. Nothing is stored, nothing is
 *    sent, and it works with the server switched off.
 *  - A **short link is created only when somebody presses Copy or Share** — the
 *    moment they have decided to send the numbers to another person anyway.
 *
 * That keeps the privacy claim true for everyone who never shares, which is most
 * people, and makes the upload a consequence of an explicit act rather than of
 * typing.
 *
 * ## What is stored, and what is not
 *
 * The opaque base64url payload and nothing else. No device id, no IP, no account:
 * they are not needed to resolve a code, and a row that carried them would turn a
 * shared calculation into a record of who calculated it. The validator refuses
 * anything that is not base64url, so this cannot quietly become a pastebin.
 *
 * ## A link can be updated by whoever made it
 *
 * The original rule was that a code stood for one payload for ever: edit a number
 * and you got a different code. That is defensible as a model and was wrong as a
 * product — somebody shares a trip into a group chat, fixes a typo, and the four
 * people holding the link go on reading the typo for ever, with nothing on either
 * end saying so.
 *
 * So a link may carry an **owner key**: a secret the client generates, keeps on
 * its own device and never shows anybody. Only its SHA-256 is stored here, so a
 * dump of this collection does not let the reader edit anybody's links. Present
 * it and `PATCH /share-links/:code` replaces the payload in place; the link
 * already sitting in the chat then resolves to the new numbers.
 *
 * There is deliberately no account behind this. The key *is* the claim, which
 * means clearing the browser's storage loses the ability to update a link — the
 * honest cost of a feature with nothing to log in to, and a much smaller cost
 * than the link going stale.
 *
 * ## Why it is deduplicated, and what the owner key does to that
 *
 * `fingerprint` is a unique hash of the payload, so pressing Copy twice returns
 * the same code instead of growing the collection once per tap.
 *
 * For an owned link the owner key hash is folded into that hash, which changes
 * what dedupe *means*: it now collapses one owner's repeated taps, and no longer
 * collapses two different people who happen to have typed the same trip. That
 * separation is required rather than tidy — sharing a row between two owners and
 * then letting one of them edit it would silently rewrite the other's link.
 *
 * Rows with no owner key keep the old key exactly, so anything already in the
 * collection goes on behaving as it did and no migration is needed.
 */

const shareLinkSchema = new mongoose.Schema(
  {
    /** The public handle. `/s/<code>` and nothing else identifies this row. */
    code: {
      type: String,
      required: true,
      default: () => generateShareCode(),
    },

    /**
     * Which page the payload belongs to, so the resolver does not have to assume.
     * One value today; see SHARE_LINK_KINDS for why it is stored anyway.
     */
    kind: {
      type: String,
      required: true,
      enum: Object.values(SHARE_LINK_KINDS),
      default: SHARE_LINK_KINDS.GROUP_EXPENSE_CALCULATOR,
    },

    /**
     * The encoded state, exactly as it appeared after `#d=`. Opaque here on
     * purpose: this server does not decode it, does not validate its contents and
     * has no schema for what is inside. The client that wrote it is the only
     * thing that reads it.
     */
    payload: {
      type: String,
      required: true,
      maxlength: LIMITS.SHARE_LINK_PAYLOAD_MAX,
    },

    /**
     * SHA-256 of `kind:payload`, or of `kind:payload:ownerKeyHash` once there is
     * an owner. The dedupe key — see the header.
     */
    fingerprint: {
      type: String,
      required: true,
    },

    /**
     * SHA-256 of the secret that may replace this payload, or null for a link
     * nobody claimed.
     *
     * The hash and never the key itself: this row is the thing most likely to be
     * read by somebody who should not have it, and a stored secret would let them
     * edit every link in the collection. Null is a real state and it is checked —
     * a link made before this existed has no owner and cannot be updated by
     * anyone, which is the behaviour it was created under.
     */
    ownerKeyHash: {
      type: String,
      default: null,
    },

    /**
     * Opens, and the last one.
     *
     * Not analytics about people — there is nobody identified here to analyse.
     * It is the only signal that distinguishes a link somebody is still using
     * from one nobody ever opened, which is what `expiresAt` below is refreshed
     * from.
     */
    hits: { type: Number, default: 0 },
    lastOpenedAt: { type: Date, default: null },

    /**
     * When Mongo may delete this row, pushed forward on every open.
     *
     * An explicit date with a zero-second TTL rather than `expireAfterSeconds` on
     * `createdAt`, because the two expire different things. From `createdAt`, a
     * link dies a year after it was made no matter how much it is used — and the
     * links that get used are precisely the ones worth keeping. From here, a link
     * dies a year after the last person opened it.
     */
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  /**
   * `updatedAt` earns its place now that a payload can change: it is the only
   * record of when a link last said something different, and the client shows it
   * as "updated just now" so the person can see their edit went out.
   */
  { timestamps: { createdAt: true, updatedAt: true } }
);

/*
 * The lookup: every read is by code.
 *
 * Declared here rather than with `unique: true` on the field. Both at once is
 * two definitions of one index, which Mongoose warns about on every boot.
 */
shareLinkSchema.index({ code: 1 }, { unique: true });

/** The dedupe. Unique, so a race ends in a duplicate-key error the service handles. */
shareLinkSchema.index({ fingerprint: 1 }, { unique: true });

/** Mongo's TTL monitor reads this: delete once `expiresAt` is in the past. */
shareLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("ShareLink", shareLinkSchema);
