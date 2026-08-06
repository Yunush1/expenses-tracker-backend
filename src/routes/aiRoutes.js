const express = require("express");
const { z } = require("zod");

const aiController = require("../controllers/aiController");
const requireAuth = require("../middlewares/requireAuth");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");

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

router.get("/suggestions", aiController.getStarters);

router.post(
  "/ask",
  writeLimiter,
  validate(
    z.object({
      question: z.string().trim().min(3).max(500),
      /**
       * The immediately preceding exchange, so a follow-up can resolve "that".
       * Optional and bounded — the client sends at most one turn, and the
       * service never treats it as a source of facts.
       */
      previousQuestion: z.string().trim().max(500).optional(),
      previousAnswer: z.string().trim().max(2000).optional(),
      /**
       * Questions already asked this session, so a follow-up suggestion never
       * offers back something answered a moment ago. Bounded — these are only
       * used to filter a list, never sent to the model.
       */
      asked: z.array(z.string().trim().max(500)).max(20).optional(),
    })
  ),
  aiController.ask
);

module.exports = router;
