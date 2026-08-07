const mongoose = require("mongoose");

const { JOIN_REQUEST_STATUS, LIMITS } = require("../constants");

/**
 * Somebody typed the group's short code and is waiting to be let in
 * (docs/13-JOIN-APPROVAL.md).
 *
 * ## Why this exists, and why only for the short code
 *
 * The invite **link** carries 96 bits of entropy. Possession of it is the
 * credential, it is shared deliberately, and guessing one is not a thing that
 * happens. It stays instant — that is the product's core promise.
 *
 * The **join code** is 8 characters from a 25-letter alphabet: about 37 bits,
 * read aloud across a table and typed by hand. Short enough to be usable, and
 * therefore short enough to be enumerated by someone patient behind the rate
 * limiter (docs/02-HLD.md §3.4 has always said as much). Until now, resolving one
 * returned the invite code — so a guessed code was full access to a group's
 * expenses, names and balances.
 *
 * Approval closes that: a correct guess now produces a request that a human has
 * to accept, and the invite code is not revealed until they do. The weak
 * credential stops being a credential and becomes a way to knock.
 */
const joinRequestSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      index: true,
    },
    /** The browser asking. The only handle on someone who is not a member yet. */
    deviceId: {
      type: String,
      required: true,
    },
    /** What they want to be called — shown to whoever decides. */
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.MEMBER_NAME_MAX,
    },
    status: {
      type: String,
      enum: Object.values(JOIN_REQUEST_STATUS),
      default: JOIN_REQUEST_STATUS.PENDING,
      index: true,
    },
    /**
     * Who decided, and when. Kept after the fact because "who let this person
     * in?" is a question a group will eventually ask, and the activity log is the
     * only place that can answer it.
     */
    decidedByMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
    },
    decidedAt: { type: Date, default: null },
    /** The member row created on approval, so the requester can be pointed at it. */
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
    },

    /**
     * Set when this is a **recovery**, not a new join: "I am Riya, I cleared my
     * browser and lost my identity."
     *
     * It has to be a request rather than a self-service action for the same
     * reason a join does. From the server's side, "I am Riya" arriving from an
     * unknown browser is indistinguishable from anyone else with the invite link
     * saying it — and the invite link is shared in a group chat. Letting it
     * through unchallenged would let any member take over any other member's
     * identity, their expenses and their balance.
     *
     * A person who already knows Riya is the only thing that can tell the two
     * apart, so a person is asked (docs/13-JOIN-APPROVAL.md §11).
     */
    claimMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
    },
    /**
     * A request nobody answers must not stay answerable forever — an approval tap
     * a week later, on a notification still sitting in a tray, would let in
     * someone who has long since given up and forgotten asking.
     */
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    /** Truncated; a debugging aid for "who was this?", never a record. */
    userAgent: { type: String, default: "", maxlength: 300 },
  },
  { timestamps: true }
);

/**
 * One live request per device per group.
 *
 * `partialFilterExpression` rather than a plain unique index: a device that was
 * declined, or that left and wants back in, must be able to ask again. Only the
 * *pending* one is unique — which is what stops a tap-happy requester filling
 * every member's notification tray.
 */
joinRequestSchema.index(
  { groupId: 1, deviceId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: JOIN_REQUEST_STATUS.PENDING },
  }
);

/** The pending list a group's members see. */
joinRequestSchema.index({ groupId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("JoinRequest", joinRequestSchema);
