const mongoose = require("mongoose");
const { SHEET_GRANTABLE_ROLES, SHEET_ROLES } = require("../constants");

/**
 * "This sheet is shared with this email address" (docs/20-EXPENSE-SHEETS.md §5).
 *
 * ## Why the grant is written before anyone accepts it
 *
 * A grant is created the moment the owner types an address, whether or not that
 * person has ever used this app. There is nothing to accept: the row *is* the
 * permission, and the email is a notification that it exists. That is what makes
 * "share with priya@acme.com" work when Priya has no account yet — she signs up
 * later, and the grant is already waiting for her.
 *
 * The alternative — an invitation token redeemed by clicking a link — was
 * rejected because a redeemable link is bearer authority: forwarded, or read out
 * of a shared inbox, it admits whoever holds it. The address is the whole point
 * of sharing by address.
 *
 * ## The binding rule, which is the security property
 *
 * A grant starts with `email` set and `userId` null. It binds to an account the
 * first time someone opens the sheet whose **verified** email matches, and from
 * then on `userId` is what grants access.
 *
 * Two things follow, and both are deliberate:
 *
 * 1. **Verification is required to bind.** Firebase does not verify an address
 *    on password sign-up, so without this check anyone could register as
 *    `cfo@acme.com` and read a sheet shared with the real one. `User.emailVerified`
 *    is explicitly *not* a gate for the personal ledger (models/user.js) — there,
 *    access is the account itself and the address proves nothing. Here the
 *    address **is** the credential, so the same field becomes load-bearing. The
 *    two positions look contradictory and are not: they are the same rule, that
 *    a claim is only trusted where something actually checked it.
 *
 * 2. **Binding is one-way and permanent.** Once `userId` is set, lookup by email
 *    is no longer consulted for that grant. So a person who later changes their
 *    address in their account keeps access, and — more importantly — someone who
 *    subsequently acquires the old address does not inherit it. Corporate email
 *    is recycled; permissions attached to a recycled address would be inherited
 *    by whoever gets the desk next.
 */
const sheetGrantSchema = new mongoose.Schema(
  {
    sheetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sheet",
      required: true,
      index: true,
    },
    /**
     * The address the owner typed, lowercased.
     *
     * Kept after binding rather than cleared, because the share list has to keep
     * showing *who* was invited — an entry that reads "someone" once accepted
     * would make the list useless for the one question it exists to answer.
     */
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    /**
     * Set on first verified match, never rewritten. Null means "invited, has not
     * opened it yet" — which is exactly what the share list shows as *Pending*.
     */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    role: {
      type: String,
      enum: SHEET_GRANTABLE_ROLES,
      default: SHEET_ROLES.VIEWER,
    },
    invitedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    /**
     * Set when the grant was created by approving a request rather than by the
     * owner offering it. Kept because "did we invite them, or did they ask?" is a
     * question an audit of who can see the numbers will eventually ask.
     */
    fromRequest: {
      type: Boolean,
      default: false,
    },
    /** When the invitee first opened the sheet — i.e. when `userId` was bound. */
    acceptedAt: {
      type: Date,
      default: null,
    },
    /**
     * Whether the invitation email actually left the building.
     *
     * Recorded because SMTP is optional (config/mail.js) and a grant is valid
     * regardless — so the share list must be able to say "invited, but we could
     * not email them; send this link" instead of leaving the owner to wonder why
     * nobody replied.
     */
    notifiedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * One grant per address per sheet.
 *
 * Unique so that re-sharing with someone already on the list is a role change
 * rather than a duplicate row — two grants for one person with different roles
 * has no correct interpretation, and whichever the query returned first would
 * become the answer.
 */
sheetGrantSchema.index({ sheetId: 1, email: 1 }, { unique: true });

/**
 * The access check on every request, and the reason it is a compound index
 * rather than one on `userId` alone: the question asked is always "does *this*
 * account have a grant on *this* sheet", never "what does this account hold".
 *
 * Partial, so the many unbound grants — every invitation not yet opened — stay
 * out of it entirely.
 */
sheetGrantSchema.index(
  { sheetId: 1, userId: 1 },
  { partialFilterExpression: { userId: { $type: "objectId" } } }
);

/** "Sheets shared with me" — the other half of the sheet list. */
sheetGrantSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model("SheetGrant", sheetGrantSchema);
