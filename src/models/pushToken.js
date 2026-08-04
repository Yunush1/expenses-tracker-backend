const mongoose = require("mongoose");

/**
 * One browser's FCM registration token, keyed by the same `deviceId` that already
 * identifies a browser to the rest of the API (docs/02-HLD.md §3.2).
 *
 * Why a separate collection rather than a field on Member: a device belongs to a
 * *browser*, not to a group. The same phone is one member in the Goa group and a
 * different member in the flatmates group, and it holds one FCM token for both.
 * Storing the token on Member would duplicate it per group and leave n copies to
 * invalidate when the token rotates — which it does, silently, whenever the
 * browser feels like it.
 *
 * The token is the address, the deviceId is the identity. A single browser has
 * exactly one token at a time, so `deviceId` is unique and re-registering
 * overwrites rather than accumulating.
 */
const pushTokenSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    /**
     * FCM hands the *same* token to a browser that clears and re-grants
     * permission, and a *rotated* one to a browser it decides has gone stale.
     * Either way two deviceIds must never end up addressing the same browser, or
     * one person gets every notification twice. Whoever registered the token most
     * recently owns it and the older row is deleted on write — unique rather than
     * merely indexed so the database enforces that instead of trusting the write
     * path to.
     */
    token: {
      type: String,
      required: true,
    },
    /** Diagnostic only — which browser this was, when a token misbehaves. */
    userAgent: {
      type: String,
      default: "",
      maxlength: 300,
    },
    /**
     * Touched on every re-registration (the app does this on each load). A token
     * nobody has refreshed in months belongs to a browser that is never coming
     * back; see pushTokenRepository.pruneStale.
     */
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

pushTokenSchema.index({ token: 1 }, { unique: true });
pushTokenSchema.index({ lastSeenAt: 1 });

module.exports = mongoose.model("PushToken", pushTokenSchema);
