const activityRepository = require("../repositories/activityRepository");
const pushService = require("./pushService");
const pointsService = require("./pointsService");
// Leaf modules — Redis only, so requiring them here introduces no cycle.
const contextCache = require("./ai/contextCache");
const cacheService = require("./cacheService");
const { toActivityDTO } = require("../serializers");
const { buildPage } = require("../utils/cursor");
const { LIMITS } = require("../constants");
const logger = require("../utils/logger");

/**
 * The single funnel every domain event passes through — and, as of push
 * notifications, where they fan out to the group's other devices.
 *
 * Writes are BEST EFFORT ON PURPOSE: if the timeline insert fails, we log it and
 * let the caller's operation succeed. Losing a log line is strictly better than
 * failing a user's expense because an audit write hiccuped.
 */
const record = async ({ groupId, type, actor = null, message, metadata = {} }, session = null) => {
  try {
    const activity = await activityRepository.create(
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

    /**
     * Deliberately not awaited, and deliberately not sent inside a transaction.
     *
     * Not awaited: every caller of `record` awaits it inside a user's write, so
     * awaiting a round trip to Google here would put FCM's latency — and FCM's
     * bad days — directly into the response time of adding an expense. The
     * notification is an after-effect of a write that has already succeeded, so
     * it is dispatched and forgotten. `notifyActivity` never rejects; the
     * `.catch` guards against an unhandled rejection if that ever stops being
     * true.
     *
     * Not inside a transaction: a push cannot be rolled back. No caller passes a
     * session today, but `record` accepts one, and a notification sent from an
     * uncommitted write would announce an expense that may never exist — and
     * send readers to a group that does not yet show it. When there is a session,
     * the commit is the event worth announcing, not this insert.
     */
    if (!session) {
      pushService
        .notifyActivity(activity, actor)
        .catch((err) => logger.error(`[activityService] Push dispatch failed: ${err.message}`));

      /**
       * The actor's assistant snapshot is now stale.
       *
       * Every domain event in the app passes through here, which makes this the
       * one place that catches "I just added an expense, now ask Ria about it"
       * without each service having to remember. Only the actor is invalidated —
       * finding every other member with an account would be a query per event
       * for a staleness the short TTL already bounds (see ai/contextCache.js).
       *
       * Not awaited, and skipped inside a transaction, on exactly the same terms
       * as the push above.
       */
      if (actor?.userId) contextCache.invalidate(actor.userId);

      /**
       * Everything cached for this group — balances, summary, members,
       * settlement suggestions — is now stale.
       *
       * This is the single funnel every domain event passes through, which is
       * what makes the cache safe: no service has to remember to invalidate, and
       * a new write path gets it for free by recording an activity. One INCR
       * makes every stale key unreachable regardless of how many views were
       * cached (services/cacheService.js).
       *
       * Not awaited — a cache that fails to clear must never fail the write.
       */
      cacheService.bumpGroup(groupId);

      /**
       * Reward points, on the same terms as the push: not awaited, never able to
       * fail the write that triggered it, and skipped inside a transaction for
       * the same reason — points awarded for an expense that then rolls back
       * cannot be taken back (docs/11-REWARDS.md).
       */
      pointsService
        .awardForActivity(activity, actor)
        .catch((err) => logger.error(`[activityService] Points award failed: ${err.message}`));
    }

    return activity;
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
