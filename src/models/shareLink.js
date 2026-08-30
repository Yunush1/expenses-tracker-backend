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
 * ## Why it is deduplicated
 *
 * `fingerprint` is a unique hash of the payload, so pressing Copy twice, or two
 * people sharing the same unchanged trip, returns the same code instead of
 * growing the collection once per tap. Editing a number produces a different
 * payload and therefore a different code — which is the same snapshot semantics
 * the fragment link already had.
 */

const shareLinkSchema = new mongoose.Schema(
  {
    /** The public handle. `/s/<code>` and nothing else identifies this row. */
    code: {
      type: String,
      required: true,
      unique: true,
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

    /** SHA-256 of `kind:payload`. The dedupe key — see the header. */
    fingerprint: {
      type: String,
      required: true,
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
  { timestamps: { createdAt: true, updatedAt: false } }
);

/** The lookup: every read is by code. */
shareLinkSchema.index({ code: 1 }, { unique: true });

/** The dedupe. Unique, so a race ends in a duplicate-key error the service handles. */
shareLinkSchema.index({ fingerprint: 1 }, { unique: true });

/** Mongo's TTL monitor reads this: delete once `expiresAt` is in the past. */
shareLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("ShareLink", shareLinkSchema);
