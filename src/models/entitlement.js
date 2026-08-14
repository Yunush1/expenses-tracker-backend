const mongoose = require("mongoose");
const { PLANS, STORED_PLAN_STATUS, PLAN_STATUS, GRANT_SOURCES } = require("../constants");

/**
 * What a group has been granted, and until when (docs/22-MONETIZATION.md §4).
 *
 * ## Why this hangs off the group and not off a person
 *
 * This is the load-bearing decision of the whole monetisation design. A group is a
 * server-side row with a durable id and a member list; a no-account visitor is a
 * random UUID in `localStorage`. Attaching money to the second means a cleared
 * cache destroys a subscription and a copied string shares it. Attaching it to the
 * first means one member pays and all five benefit — which is also the only fair
 * reading of a tool for *shared* expenses.
 *
 * The consequence, stated plainly: **a payer needs an account, a beneficiary does
 * not.** Taking money requires an identity for the receipt, the refund and the
 * cancellation, so whoever upgrades signs in. The other four members never do and
 * notice nothing except that the group has more features.
 *
 * ## Why FREE is never stored
 *
 * A group with no row here and a group whose row expired last Tuesday are the same
 * thing — both resolve to FREE, which is a real plan with real limits rather than
 * an absence (§6). That means:
 *
 *   - no backfill: every group that existed before this collection is already FREE;
 *   - no sweep job: expiry is a fact about a date, computed on read, so a plan
 *     cannot outlive its term because a cron did not fire;
 *   - one downgrade path instead of two.
 *
 * Revoking is therefore an expiry set to *now*, not a delete. The row is what a
 * refund or a billing question is answered from later, and deleting it to express
 * "this group is free again" would throw that away to save a document.
 *
 * ## What a leaked invite link cannot do
 *
 * Grant premium to a stranger's group. The link grants membership of *this* group,
 * and the entitlement is a property of the same group — so the check is always
 * "what is this group on", never "is this device premium". There is no device id
 * in this schema, and there must never be one.
 */
const entitlementSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
      unique: true,
    },
    /**
     * Only the paid plans appear here. FREE is the absence of a live row — see
     * above — so a `plan: "FREE"` document would be a second way to say nothing,
     * and the two would eventually disagree.
     */
    plan: {
      type: String,
      enum: [PLANS.GROUP_PRO, PLANS.TRIP_PASS],
      required: true,
    },
    /**
     * TRIAL, ACTIVE, PAST_DUE or CANCELLED. `EXPIRED` and `FREE` are derived from
     * `expiresAt` and never written — see PLAN_STATUS.
     *
     * All four still entitle the group while `expiresAt` is in the future. A
     * failed renewal is a conversation with the payer, not a reason to take
     * features from four other people the same afternoon.
     */
    status: {
      type: String,
      enum: STORED_PLAN_STATUS,
      default: PLAN_STATUS.ACTIVE,
    },
    /**
     * When it stops. `null` means never — a permanent promo or a deliberately
     * open-ended operator grant.
     *
     * Not indexed, because nothing scans for expired rows: they are resolved on
     * read by the group they belong to, which is already an indexed lookup. An
     * index here would exist purely to serve a sweep job that this design does not
     * need.
     */
    expiresAt: {
      type: Date,
      default: null,
    },
    source: {
      type: String,
      enum: Object.values(GRANT_SOURCES),
      default: GRANT_SOURCES.ADMIN,
    },
    /**
     * Who is paying — a reference for billing and cancellation, **not** a licence.
     *
     * Removing this member from the group must not revoke the entitlement
     * mid-period, and leaving the group does not take the plan with them: the plan
     * belongs to the group. Nothing in the resolver reads this field, which is how
     * that guarantee is kept rather than merely intended.
     */
    paidByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /**
     * The operator who issued a hand grant, for the audit trail that exists in
     * place of a billing system. Same allowlisted address `requireAdmin` checks.
     */
    grantedByEmail: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    /** Why. Free text, read by humans looking at a grant six months later. */
    note: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Entitlement", entitlementSchema);
