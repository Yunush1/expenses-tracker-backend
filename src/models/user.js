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
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
