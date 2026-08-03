const activityRepository = require("../repositories/activityRepository");
const { toActivityDTO } = require("../serializers");
const { buildPage } = require("../utils/cursor");
const { LIMITS } = require("../constants");
const logger = require("../utils/logger");

/**
 * The single funnel every domain event passes through — which is also where a
 * notification queue would hook in later (docs/02-HLD.md §9).
 *
 * Writes are BEST EFFORT ON PURPOSE: if the timeline insert fails, we log it and
 * let the caller's operation succeed. Losing a log line is strictly better than
 * failing a user's expense because an audit write hiccuped.
 */
const record = async ({ groupId, type, actor = null, message, metadata = {} }, session = null) => {
  try {
    return await activityRepository.create(
      {
        groupId,
        type,
        actorMemberId: actor?._id ?? null,
        actorName: actor?.name ?? "Someone",
        message,
        metadata,
      },
      session
    );
  } catch (err) {
    logger.error(`[activityService] Failed to record ${type} for group ${groupId}: ${err.message}`);
    return null;
  }
};

const list = async (groupId, { cursor, limit = LIMITS.DEFAULT_PAGE_SIZE, type } = {}) => {
  const rows = await activityRepository.listByGroup(groupId, { cursor, limit, type });
  const page = buildPage(rows, limit);

  return {
    items: page.items.map(toActivityDTO),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
};

module.exports = { record, list };
