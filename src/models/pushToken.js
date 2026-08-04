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
     * IANA zone reported by the browser (`Intl…resolvedOptions().timeZone`).
     *
     * The daily nudge is supposed to land in the evening, and an evening is a
     * local thing. Without this the server would have to pick one timezone and be
     * wrong for everyone outside it — a 9pm reminder arriving at 4am is not a
     * reminder, it is a reason to turn notifications off. Falls back to the
     * configured default when a browser will not say.
     */
    timeZone: {
      type: String,
      default: "",
      maxlength: 64,
    },
    /**
     * The device's own local date, `YYYY-MM-DD`, on which it was last nudged.
     *
     * A date string rather than a timestamp because the question being asked is
     * "has this device already been nudged *today*, where today is theirs" —
     * comparing instants would need the timezone maths repeated at every read,
     * and would land wrong either side of midnight.
     */
    lastNudgeOn: {
      type: String,
      default: "",
    },
    /**
     * The evening reminder, switched separately from expense alerts.
     *
     * This separation is the point, not a nicety. Browser push permission is
     * one-way: block it and the app can never ask again, and the useful
     * notifications — someone added ₹2,400, you owe half — die with the nag. If
     * the only way to stop a daily reminder is to block the site, people will
     * block the site. This is the escape hatch that keeps the signal alive.
     */
    dailyNudgeEnabled: {
      type: Boolean,
      default: true,
    },
    /**
     * Consecutive nudges after which nothing was logged.
     *
     * A reminder nobody acts on is not a reminder, and the honest response to
     * being ignored is to stop — silence costs nothing, whereas nagging costs the
     * permission. Reset the moment they log something; past the threshold the
     * cadence drops to roughly weekly rather than stopping dead, so someone who
     * simply had a quiet fortnight is not written off forever.
     */
    unansweredNudges: {
      type: Number,
      default: 0,
    },
    /**
     * The UTC instant this device is next due a reminder — precomputed, indexed.
     *
     * This exists so the scheduler does not have to look at everybody. The
     * obvious implementation loads every token each tick and asks `Intl` what
     * time it is where that device is: three formatter calls per device, ninety-six
     * times a day, ninety-five of which find nobody due. That is O(all devices)
     * of pure CPU to discover that nothing needs doing.
     *
     * Storing the answer turns the tick into an indexed range query that returns
     * only the handful actually due. The wall-clock check still runs afterwards
     * as the authority — this field is an index, not a source of truth, and a
     * stale one (timezone changed, window reconfigured) must not be able to send
     * at the wrong hour.
     */
    nextNudgeAt: {
      type: Date,
      default: null,
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
// The scheduler's only query. Compound so the index alone answers it, rather
// than fetching every enabled device and filtering by date in memory.
pushTokenSchema.index({ dailyNudgeEnabled: 1, nextNudgeAt: 1 });

module.exports = mongoose.model("PushToken", pushTokenSchema);
