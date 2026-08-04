const PushToken = require("../models/pushToken");

/** All push-token queries live here. No business rules — those belong to the service. */

/**
 * Register or refresh this browser's token.
 *
 * The delete-then-upsert is not belt and braces: both fields are unique, and the
 * two rows that can collide are different ones. Re-registering the same browser
 * collides on `deviceId`; a token that FCM has reassigned to a browser we already
 * know collides on `token`. Clearing the token's previous owner first means the
 * upsert below can only ever hit its own row.
 */
const upsert = async ({ deviceId, token, userAgent = "", timeZone = "", nextNudgeAt = null }) => {
  await PushToken.deleteMany({ token, deviceId: { $ne: deviceId } });

  // `timeZone` only when the browser actually reported one — an empty string here
  // would overwrite a good value with nothing on the next page load.
  const set = { token, userAgent, lastSeenAt: new Date() };
  if (timeZone) set.timeZone = timeZone;
  // Recomputed on every registration, so a device that has travelled or changed
  // its clock is rescheduled without waiting for the scheduler to notice.
  if (nextNudgeAt) set.nextNudgeAt = nextNudgeAt;

  return PushToken.findOneAndUpdate(
    { deviceId },
    { $set: set },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

const findByDeviceId = (deviceId) => PushToken.findOne({ deviceId }).lean();

const setDailyNudge = (deviceId, enabled) =>
  PushToken.findOneAndUpdate(
    { deviceId },
    {
      $set: {
        dailyNudgeEnabled: enabled,
        // Turning it back on clears the back-off — an explicit opt-in outranks
        // whatever the ignore counter had concluded — and drops the stored
        // due-time so the next tick recomputes it rather than honouring a stale
        // one from before the switch was flipped.
        ...(enabled ? { unansweredNudges: 0, nextNudgeAt: null } : {}),
      },
    },
    { new: true }
  );

const findByDeviceIds = (deviceIds) => {
  if (!deviceIds?.length) return Promise.resolve([]);
  return PushToken.find({ deviceId: { $in: deviceIds } }).lean();
};

const removeByDeviceId = (deviceId) => PushToken.deleteOne({ deviceId });

/** Called with the tokens FCM has just told us are dead. */
const removeByTokens = (tokens) => {
  if (!tokens?.length) return Promise.resolve({ deletedCount: 0 });
  return PushToken.deleteMany({ token: { $in: tokens } });
};

const pruneStale = (before) => PushToken.deleteMany({ lastSeenAt: { $lt: before } });

module.exports = {
  upsert,
  findByDeviceId,
  findByDeviceIds,
  setDailyNudge,
  removeByDeviceId,
  removeByTokens,
  pruneStale,
};
