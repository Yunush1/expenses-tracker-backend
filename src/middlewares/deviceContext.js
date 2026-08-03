const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extracts the browser's device id. Never throws: a missing device id only matters
 * for endpoints that require a member, and those enforce it themselves via
 * requireMember. Anyone holding an invite link can still read the group.
 */
const deviceContext = (req, res, next) => {
  const raw = req.get("X-Device-Id");
  req.deviceId = raw && UUID_PATTERN.test(raw.trim()) ? raw.trim() : null;
  return next();
};

module.exports = deviceContext;
module.exports.UUID_PATTERN = UUID_PATTERN;
