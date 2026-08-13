const mongoose = require("mongoose");
const { SHEET_REQUEST_STATUS, SHEET_GRANTABLE_ROLES, SHEET_ROLES, LIMITS } = require("../constants");

/**
 * "Someone is asking to be let into this sheet" (docs/20-EXPENSE-SHEETS.md §6).
 *
 * ## Why this can exist at all
 *
 * Because a share code identifies a sheet without granting anything. A caller
 * holding the link to a `PRIVATE` sheet gets a 403 carrying just enough to knock:
 * the sheet's title and who owns it. That is a deliberate, bounded disclosure —
 * it is what makes "Request access" possible instead of a dead end, and it is
 * exactly the trade Google Docs makes. Returning a flat 404 would hide the title
 * and also make the feature impossible; returning the *contents* would make the
 * private setting meaningless.
 *
 * ## Why the requester is an account, not a device
 *
 * The owner is being asked to make a decision about a person, and the only thing
 * they can decide on is a name and an address they might recognise. A device id
 * tells them nothing — "an unknown browser would like access to your payroll
 * expenses" is not a question anyone can answer. The approval also has to *grant*
 * something durable, and the durable thing here is a `SheetGrant` keyed to an
 * account.
 *
 * This is the same argument docs/13-JOIN-APPROVAL.md makes for group joins,
 * reaching the opposite conclusion about identity for the opposite reason: there,
 * requiring an account would have broken the no-login promise, and the group's
 * members personally know who is knocking. Here nobody is in the room.
 */
const sheetAccessRequestSchema = new mongoose.Schema(
  {
    sheetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sheet",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /**
     * Snapshotted from the account at the time of asking, rather than joined on
     * read.
     *
     * The owner is deciding on the strength of "priya@acme.com wants access", so
     * the address they saw when they decided is the one worth keeping. Reading it
     * live would mean a requester could change their display name — or their
     * email — between asking and being approved, and the owner would have
     * approved something other than what they read.
     */
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },
    /** "I'm covering for Riya this week" — optional, and often the whole basis of the decision. */
    message: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    /** What they asked for. The owner decides what they actually get. */
    requestedRole: {
      type: String,
      enum: SHEET_GRANTABLE_ROLES,
      default: SHEET_ROLES.VIEWER,
    },
    status: {
      type: String,
      enum: Object.values(SHEET_REQUEST_STATUS),
      default: SHEET_REQUEST_STATUS.PENDING,
      index: true,
    },
    decidedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
    /** What was actually granted on approval — not necessarily what was asked for. */
    grantedRole: {
      type: String,
      enum: SHEET_GRANTABLE_ROLES,
      default: null,
    },
    /**
     * Requests lapse (`SHEET_REQUEST_TTL_DAYS`) so an approval tap on a
     * months-old email cannot admit someone who has long since moved on — the
     * same reasoning as a group join request, with a window measured in weeks
     * rather than minutes because the people involved are not in the same room.
     *
     * A TTL index rather than a swept status: unlike a group request, nothing in
     * this app needs to *show* an expired one, so deleting it outright is both
     * simpler and leaves nothing to display incorrectly.
     */
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

/**
 * One live request per account per sheet.
 *
 * Partial on PENDING, so someone who was declined — or who was granted access
 * and later removed — can ask again. Only the *unanswered* one is unique, which
 * is what stops repeated tapping filling an owner's inbox.
 */
sheetAccessRequestSchema.index(
  { sheetId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: SHEET_REQUEST_STATUS.PENDING },
  }
);

/** The pending list an owner sees in the share dialog. */
sheetAccessRequestSchema.index({ sheetId: 1, status: 1, createdAt: -1 });

/**
 * Mongo removes the document once `expiresAt` passes.
 *
 * `expireAfterSeconds: 0` means "at the time in this field", not "immediately" —
 * the field itself carries the deadline. The background sweep runs about once a
 * minute, so removal is prompt rather than instant; nothing here depends on the
 * exact moment, and every read filters on status anyway.
 */
sheetAccessRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("SheetAccessRequest", sheetAccessRequestSchema);
