const asyncHandler = require("../middlewares/asyncHandler");
const pushService = require("../services/pushService");
const { isPushEnabled } = require("../config/firebase");
const { isValidTimeZone } = require("../utils/localTime");
const { ValidationError } = require("../errors");
const { ok } = require("../utils/apiResponse");

/**
 * Push registration is device-scoped, not group-scoped: one browser holds one
 * token and hears about every group it belongs to, so these routes sit outside
 * `/groups/:inviteCode` and need no member resolution — only the `X-Device-Id`
 * every request already carries.
 */

exports.getStatus = asyncHandler(async (req, res) =>
  ok(res, { enabled: isPushEnabled() })
);

exports.registerToken = asyncHandler(async (req, res) => {
  if (!req.deviceId) {
    throw new ValidationError("A device id is required to receive notifications");
  }

  await pushService.registerToken({
    deviceId: req.deviceId,
    token: req.body.token,
    // Truncated to the column bound; it is a debugging aid, not a record.
    userAgent: (req.get("User-Agent") || "").slice(0, 300),
    // Checked against Intl rather than taken on trust: it comes from a client,
    // and an unknown zone would throw inside the scheduled job — at 8pm, far
    // from here, for a device nobody is looking at.
    timeZone: isValidTimeZone(req.body.timeZone) ? req.body.timeZone : "",
  });

  return ok(res, { registered: true });
});

exports.getPreferences = asyncHandler(async (req, res) => {
  if (!req.deviceId) throw new ValidationError("A device id is required");
  return ok(res, await pushService.getPreferences(req.deviceId));
});

exports.updatePreferences = asyncHandler(async (req, res) => {
  if (!req.deviceId) throw new ValidationError("A device id is required");
  return ok(res, await pushService.setDailyNudge(req.deviceId, req.body.dailyNudge));
});

exports.unregisterToken = asyncHandler(async (req, res) => {
  if (!req.deviceId) {
    throw new ValidationError("A device id is required");
  }

  await pushService.unregisterDevice(req.deviceId);
  return ok(res, { registered: false });
});
