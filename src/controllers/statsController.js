const asyncHandler = require("../middlewares/asyncHandler");
const siteStatsService = require("../services/siteStatsService");
const { ok } = require("../utils/apiResponse");
const { isBot } = require("../utils/siteStats");
const logger = require("../utils/logger");

/**
 * `POST /api/stats/visit` — the site's page-view beacon.
 *
 * Always answers 204 and never an error the browser would log: the beacon is
 * fire-and-forget, and a failure to count a view must never surface on a page
 * someone is reading. Crawlers and lab tools are answered the same way and
 * simply not counted.
 */
exports.recordVisit = async (req, res) => {
  res.status(204).end();

  if (isBot(req.get("user-agent"))) return;

  try {
    await siteStatsService.recordVisit(req.body);
  } catch (err) {
    logger.warn(`[stats] visit not recorded: ${err.message}`);
  }
};

/** `GET /api/stats/admin/overview?days=30` — operator only (see statsRoutes.js). */
exports.getOverview = asyncHandler(async (req, res) =>
  ok(res, await siteStatsService.overview(req.validatedQuery))
);
