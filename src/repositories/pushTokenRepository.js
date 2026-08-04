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
const upsert = async ({ deviceId, token, userAgent = "" }) => {
  await PushToken.deleteMany({ token, deviceId: { $ne: deviceId } });

  return PushToken.findOneAndUpdate(
    { deviceId },
    { $set: { token, userAgent, lastSeenAt: new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

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
  findByDeviceIds,
  removeByDeviceId,
  removeByTokens,
  pruneStale,
};
