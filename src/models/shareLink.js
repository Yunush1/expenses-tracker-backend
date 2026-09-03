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
 * The calculation twice, and nothing about the people doing it. No device id, no
 * IP, no account: they are not needed to resolve a code, and a row that carried
 * them would turn a shared calculation into a record of who calculated it.
 *
 *  - **`payload`** is the encoded form and remains authoritative. It is what the
 *    client decodes, what a `#d=` link carries, and the only field the resolver
 *    needs. The validator refuses anything that is not base64url.
 *  - **`data`** is the same calculation as readable rows — people, their entries,
 *    the amounts — so the collection can be inspected, queried and totalled
 *    without a decoder. Written by the client from the *same object* it hands the
 *    encoder, so the two cannot describe different trips.
 *
 * The honest cost of `data`: this row now contains text somebody typed, where
 * before it was an opaque blob. Names and descriptions are length-capped hard by
 * the validator and are never rendered as markup anywhere, but "the server cannot
 * read your trip" is no longer true, and that sentence is not repeated where it
 * would now be false.
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

/** One line somebody typed: what it was for, what it cost, who did not share it. */
const shareExpenseSchema = new mongoose.Schema(
  {
    what: { type: String, default: "", trim: true, maxlength: LIMITS.SHARE_LINK_WHAT_MAX },
    /** Minor units, like every other amount in this app (docs/05-ALGORITHMS.md §1). */
    amountMinor: { type: Number, default: 0, min: 0 },
    /**
     * Positions in `people`, not ids — the same convention the encoded payload
     * uses, so the two forms say the same thing about who shared what.
     */
    excluded: { type: [Number], default: [] },
  },
  { _id: false }
);

const sharePersonSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true, maxlength: LIMITS.SHARE_LINK_NAME_MAX },
    expenses: { type: [shareExpenseSchema], default: [] },
  },
  { _id: false }
);

const shareDataSchema = new mongoose.Schema(
  {
    currency: { type: String, default: "INR", maxlength: 3 },
    people: { type: [sharePersonSchema], default: [] },
    /** Derived on write — see the note on `data` below. */
    peopleCount: { type: Number, default: 0 },
    expenseCount: { type: Number, default: 0 },
    totalMinor: { type: Number, default: 0 },
  },
  { _id: false }
);

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
     * The encoded state, exactly as it appeared after `#d=`.
     *
     * Still the authoritative copy, and still opaque to this server: it is not
     * decoded here and there is no schema for what is inside. `data` below is the
     * readable mirror of it, not a replacement — a `#d=` link has to keep working
     * with no row at all, which only the encoded form can do.
     */
    payload: {
      type: String,
      required: true,
      maxlength: LIMITS.SHARE_LINK_PAYLOAD_MAX,
    },

    /**
     * The same calculation as rows: who is in it, what each of them entered.
     *
     * Optional, because a client that only sends the payload is still a valid
     * client and a row written before this existed is still a valid row. Absent
     * rather than empty in that case — an empty `people` array would read as "a
     * shared trip with nobody in it", which is a different and wrong fact.
     *
     * The three counts are derived on the server from `people` rather than taken
     * from the request. A client-asserted total is a number that can disagree with
     * the rows beside it, and the first time it does, nobody knows which to trust.
     */
    data: {
      type: shareDataSchema,
      default: null,
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
