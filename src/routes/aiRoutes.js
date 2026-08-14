const express = require("express");

const aiController = require("../controllers/aiController");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const { askSchema } = require("../validators/aiValidators");

const router = express.Router();

/**
 * The finance assistant — account-gated, like the ledger it reads
 * (docs/10-AI-ASSISTANT.md §3).
 *
 * `requireAuth` is on the router rather than each route: these endpoints spend
 * real money per call, and a route that forgot the guard would be an open,
 * metered API. Applying it once at the mount makes "did I remember?"
 * unanswerable in the wrong direction.
 *
 * The per-account daily quota in assistantService is the real cost control; the
 * IP-based `writeLimiter` here only stops a burst.
 */
router.use(requireAuth);

router.get("/status", aiController.getStatus);

/**
 * Spend this month — operator only, and enforced here rather than in the client.
 *
 * Declared before the other reads for no reason but readability; the important
 * thing is `requireAdmin` sitting between `requireAuth` (applied to this router
 * above) and the handler, so an ordinary signed-in account gets a 403 from the
 * server and not merely a hidden card.
 */
router.get("/usage", requireAdmin, aiController.getUsage);

router.get("/suggestions", aiController.getStarters);

/**
 * The conversation itself. A plain read and a delete — no quota and no provider
 * call, because neither costs anything to serve.
 */
router.get("/history", aiController.getHistory);
router.delete("/history", writeLimiter, aiController.clearHistory);

router.post(
  "/ask",
  writeLimiter,
  validate(askSchema),
  aiController.ask
);

module.exports = router;
