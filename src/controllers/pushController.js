const asyncHandler = require("../middlewares/asyncHandler");
const pushService = require("../services/pushService");
const { isPushEnabled } = require("../config/firebase");
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
  });

  return ok(res, { registered: true });
});

exports.unregisterToken = asyncHandler(async (req, res) => {
  if (!req.deviceId) {
    throw new ValidationError("A device id is required");
  }

  await pushService.unregisterDevice(req.deviceId);
  return ok(res, { registered: false });
});
