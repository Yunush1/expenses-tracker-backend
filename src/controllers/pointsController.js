const asyncHandler = require("../middlewares/asyncHandler");
const pointsService = require("../services/pointsService");
const { POINTS, POINT_RULES } = require("../constants");
const { ok } = require("../utils/apiResponse");

/**
 * Reward points.
 *
 * Read-only, deliberately. There is no endpoint to claim, grant or transfer
 * points — every earn originates server-side from a domain event
 * (docs/11-REWARDS.md §6). A client-assertable award endpoint would be farmed
 * within a day, and no amount of validation on it would help.
 */

exports.getSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [balance, streak, events] = await Promise.all([
    pointsService.getBalance(userId),
    pointsService.currentStreak(userId),
    pointsService.recentEvents(userId),
  ]);

  return ok(res, {
    balance,
    streak,
    /** So the UI can explain earning without hard-coding the numbers twice. */
    rules: Object.entries(POINT_RULES).map(([type, rule]) => ({
      type,
      points: rule.points,
      limit: rule.once ? "once" : `${rule.perDay}/day`,
    })),
    costs: { aiQuestion: POINTS.AI_QUESTION_COST },
    dailyEarnCap: POINTS.DAILY_EARN_CAP,
    events: events.map((event) => ({
      type: event.type,
      points: event.points,
      at: event.createdAt,
    })),
  });
});
