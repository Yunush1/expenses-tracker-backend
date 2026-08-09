const mongoose = require("mongoose");
const { LIMITS } = require("../constants");
const { generateMemberCode } = require("../utils/userCode");

const memberSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.MEMBER_NAME_MAX,
    },
    /**
     * Every browser this person uses. One human with a phone, a laptop and a work
     * machine is one member with three device ids — not three members, which is
     * what a single `deviceId` produced: three sets of balances, and a settlement
     * engine cheerfully suggesting they pay themselves.
     *
     * Devices are added by the link-code flow (see memberService.linkDevice), never
     * by simply presenting an unknown id, or possession of the invite link would be
     * enough to impersonate anyone in the group.
     */
    deviceIds: {
      type: [String],
      default: [],
    },
    /**
     * @deprecated Superseded by `deviceIds[]`. Still read by memberRepository so
     * documents written before the migration keep resolving; cleared by
     * `npm run migrate:devices`.
     */
    deviceId: {
      type: String,
      default: null,
    },
    /**
     * A short code shown on a device that is already linked, typed into one that is
     * not. Stored as a hash so a database dump does not hand out identities, and
     * short-lived because it is read off one screen and typed into another.
     */
    linkCode: {
      hash: { type: String, default: null },
      expiresAt: { type: Date, default: null },
    },
    /**
     * This member's public address (docs/18-USER-CODE.md).
     *
     * ## Why members need one when accounts already have `userCode`
     *
     * Most members have no account at all — that is the whole product. An
     * anonymous member cannot be named by a `userCode` because there is no user,
     * so without this there is no way to point at "Aman in the Goa group" from
     * outside that group.
     *
     * ## What it is emphatically not
     *
     * Not a credential, and not a person. It addresses a **member row**, which
     * is scoped to one group: someone in three groups has three of these, and
     * none of them is "them" in the way `user.userCode` is. Use it to name a
     * counterparty; never to identify a human across groups, and never as proof
     * of identity — device linking still requires the short-lived `linkCode`
     * (docs/17-MEMBER-IDENTITY.md §3).
     *
     * A `default` rather than assignment in each service, so every route in —
     * creating a group, joining by link, being added by hand, a claim approval —
     * produces one without having to remember. The unique index is the backstop
     * for the astronomically unlikely collision.
     */
    memberCode: {
      type: String,
      uppercase: true,
      trim: true,
      default: generateMemberCode,
    },
    isCreator: {
      type: Boolean,
      default: false,
    },
    /** Removal is a deactivation, so historical expenses keep resolving their names. */
    isActive: {
      type: Boolean,
      default: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    /** Reserved for the authentication phase — see docs/02-HLD.md §9. */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: true }
);

memberSchema.index({ groupId: 1, isActive: 1 });
memberSchema.index({ groupId: 1, deviceIds: 1 });
// Retained for the legacy half of the findByDevice lookup until the migration has
// run everywhere.
memberSchema.index({ groupId: 1, deviceId: 1 });
memberSchema.index({ groupId: 1, "linkCode.hash": 1 });
/**
 * Global, not per group: a member code is looked up on its own, by someone who
 * does not know which group it belongs to — that is the point of it.
 *
 * Sparse, so rows created before this field existed do not all collide on a
 * missing value.
 */
memberSchema.index({ memberCode: 1 }, { unique: true, sparse: true });
/**
 * "Which groups does this account belong to?" — the question the ledger's member
 * picker is built on (docs/17-MEMBER-IDENTITY.md §7).
 *
 * Partial, because `userId` is null on every member who has never linked, which
 * is most of them: groups work with no account and always will.
 */
memberSchema.index(
  { userId: 1, isActive: 1 },
  { partialFilterExpression: { userId: { $type: "objectId" } } }
);

// Member names are intentionally NOT unique — two people called "Rahul" is a real
// scenario, and rejecting it would be worse than showing both.

module.exports = mongoose.model("Member", memberSchema);
