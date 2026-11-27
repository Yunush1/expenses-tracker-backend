const express = require("express");

const statsController = require("../controllers/statsController");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const validate = require("../middlewares/validate");
const { visitLimiter } = require("../middlewares/rateLimiter");
const { ValidationError } = require("../errors");
const { visitBody, overviewQuery } = require("../validators/statsValidators");

const router = express.Router();

/**
 * Visitor and usage numbers.
 *
 * Same split as blogRoutes.js: the one public write is the beacon, and
 * everything under `/admin` is `requireAuth` then `requireAdmin`, in that order.
 */

/**
 * The beacon is sent as `text/plain` (navigator.sendBeacon / fetch keepalive),
 * because that is a CORS "simple" request: no preflight, so a view is counted
 * even when the visitor is already leaving the page. The global JSON parser
 * ignores that content type, so it is parsed here, and capped small.
 */
const parseTextJson = (req, res, next) => {
  if (typeof req.body !== "string") return next();
  try {
    req.body = JSON.parse(req.body);
    return next();
  } catch {
    return next(new ValidationError("Invalid body"));
  }
};

router.post(
  "/visit",
  visitLimiter,
  express.text({ type: "text/plain", limit: "2kb" }),
  parseTextJson,
  validate(visitBody),
  statsController.recordVisit
);

router.get(
  "/admin/overview",
  requireAuth,
  requireAdmin,
  validate(overviewQuery, "query"),
  statsController.getOverview
);

module.exports = router;
