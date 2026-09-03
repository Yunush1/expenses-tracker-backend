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
 * ## The link is the document, and everybody holding it may write
 *
 * The original rule was that a code stood for one payload for ever: edit a number
 * and you got a different code. That was wrong as a product — somebody shares a
 * trip into a group chat, fixes a typo, and the people holding the link go on
 * reading the typo, with nothing on either end saying so.
 *
 * The first fix made the *creator* able to update it. That was still wrong, for
 * the symmetrical reason: the whole point of sending a trip to four people is
 * that they correct it. "You forgot the taxi" is the normal response to a shared
 * calculation, and a reader who cannot add the taxi has to send a message asking
 * somebody else to.
 *
 * So the code is a **capability**, exactly like a group's invite link
 * (docs/02-HLD.md §3.4): holding it is permission to read *and* to write. There is
 * no account here to check anything else against, and inventing one would be a
 * different product.
 *
 * **What that costs, stated plainly:** anyone the link reaches can change the
 * numbers, including somebody it was forwarded to. There is no history, no
 * attribution and no undo. That is the same trade a document shared as "anyone
 * with the link can edit" makes, and the page says so where people can read it.
 *
 * ## `revision`, and why last-write-wins was not enough
 *
 * Two people editing at once is now ordinary rather than impossible, and a plain
 * overwrite loses whichever edit lands second — silently, which is the part that
 * matters. Every write therefore states the revision it was based on, and the
 * server refuses one built on a stale copy with a 409. The client then reconciles
 * rather than clobbering: it can see it is behind, and asks.
 *
 * ## About `fingerprint`
 *
 * It carries `code`, so it is unique per row and no longer deduplicates anything.
 * That is deliberate. Content dedupe was a saving when a payload was immutable;
 * with editable rows it would hand two strangers who typed the same trip one
 * shared document, and one of them would silently rewrite the other's.
 *
 * The field and its unique index stay because dropping a unique index needs a
 * migration, and a half-applied one leaves every insert failing on a duplicate
 * null. Keeping a per-row hash costs one column and needs no operational step. It
 * can be removed whenever there is a migration to spare.
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

    /** SHA-256 of `kind:code:payload` — unique per row, not a dedupe key. See the header. */
    fingerprint: {
      type: String,
      required: true,
    },

    /**
     * How many times this has been written, starting at 1.
     *
     * The concurrency check and nothing more: a client sends the revision its
     * edit was based on, and a mismatch means somebody saved in between. Not a
     * history — there is only ever one payload here, and the previous one is
     * gone.
     */
    revision: {
      type: Number,
      default: 1,
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
