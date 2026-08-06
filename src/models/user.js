const mongoose = require("mongoose");

/**
 * A signed-in person — for the personal ledger, and nothing else
 * (docs/09-AUTH.md §1).
 *
 * ## What is deliberately absent
 *
 * No password, no salt, no reset token, no session, no refresh token. Firebase
 * holds every credential and runs every flow that touches one: sign-in, password
 * reset, email verification, revocation. What survives here is the minimum needed
 * to own rows in this database and to render a name in the UI.
 *
 * That absence is the security posture, not an oversight. A dump of this
 * collection leaks a list of email addresses; it cannot be replayed into anyone's
 * account, because nothing in it authenticates anybody.
 *
 * ## Why `firebaseUid` is the only identifier that matters
 *
 * It is stable for the life of the account — including across provider linking,
 * so someone who signs up with a password and later attaches Google keeps the same
 * uid, the same row, and the same ledger. `email` is not stable in that way (it
 * can be changed in the account) and must never be used as a key.
 */
const userSchema = new mongoose.Schema(
  {
    firebaseUid: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    /** Display and support only. Never a lookup key — see above. */
    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    /**
     * Mirrored from the token, and **not** a gate. A Google sign-in is verified by
     * construction; an email/password one is not until the link is clicked.
     * Blocking an unverified user from their own ledger would punish them for our
     * bookkeeping — nothing there is reachable by anyone else regardless, because
     * access is the account rather than the address. Stored so that using email as
     * a recovery channel stays a decision we can still make.
     */
    emailVerified: {
      type: Boolean,
      default: false,
    },
    displayName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },
    photoURL: {
      type: String,
      default: "",
      maxlength: 500,
    },
    phoneNumber: {
      type: String,
      default: "",
      trim: true,
      maxlength: 20,
    },
    /**
     * `google.com` or `password`, from the token's `firebase.sign_in_provider`.
     *
     * Diagnostics only — useful when someone reports "it forgot my account" and
     * the answer is that they used the other button. **Never an authorisation
     * input:** the token's validity is the only thing that decides access, and
     * branching on the provider would invent a second, weaker rule.
     */
    signInProvider: {
      type: String,
      default: "",
    },
    /**
     * Browsers this account has signed in on.
     *
     * **A record of association, not a grant of ownership.** It exists so a
     * ledger reminder can reach every browser the person actually uses, rather
     * than only the one that happened to create the entry.
     *
     * What it deliberately does **not** do is transfer group identity. A
     * `deviceId` names a browser, and browsers are shared — a family laptop, a
     * hostel machine, a phone handed over to book a cab. If signing in silently
     * claimed whatever that browser already was in a group, then one person
     * signing into their own account on a shared machine would inherit somebody
     * else's membership, their expenses and their balance. The device is evidence
     * that a browser was used, never proof of who was using it, so nothing is
     * reassigned on the strength of it. See docs/09-AUTH.md §1.
     */
    deviceIds: {
      type: [String],
      default: [],
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },

    /**
     * This account's own invite code — the thing that goes in a shared link.
     *
     * Assigned lazily, on first request for it, rather than at sign-up: most
     * accounts never share anything, and an unused code is a unique index entry
     * and a collision-retry loop paid for nothing. `sparse` is what makes that
     * possible — without it every user missing a code would collide on `null`.
     */
    /**
     * Note the deliberate absence of `default: null`. A default is *written*, so
     * every account would carry an explicit `referralCode: null` — and a sparse
     * index skips missing fields, not null ones. The index would then treat null
     * as a value, and the second account to exist would collide with the first.
     *
     * Left undefined, the field is simply absent until a code is allocated, which
     * is what makes the unique index affordable. Queries are unaffected:
     * `{ referralCode: null }` matches missing and null alike.
     */
    referralCode: {
      type: String,
      uppercase: true,
      trim: true,
    },

    /**
     * Who invited this person. Written **once**, when the account row is created,
     * and never again.
     *
     * Immutability is the whole security property. If this could be set later,
     * every account in the system would be a standing target for "attach yourself
     * to me" — and the natural version of that (a `POST /referrals/claim` anyone
     * can call) would let one operator harvest the entire existing user base into
     * their downline overnight. There is no code path that updates this field;
     * see referralService.
     */
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    /**
     * When this person first did something real — not when they signed up.
     *
     * The upline is paid at this moment, once, and this field is the latch that
     * makes "once" true: it is set by a conditional update that only matches while
     * it is still null, so two concurrent qualifying events cannot both pay out.
     */
    referralQualifiedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

userSchema.index({ referralCode: 1 }, { unique: true, sparse: true });
userSchema.index({ referredBy: 1 });

module.exports = mongoose.model("User", userSchema);
