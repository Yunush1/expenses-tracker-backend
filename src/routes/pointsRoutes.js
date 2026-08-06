const express = require("express");

const pointsController = require("../controllers/pointsController");
const requireAuth = require("../middlewares/requireAuth");

const router = express.Router();

/**
 * Points belong to an account, so this sits behind `requireAuth` like the ledger
 * and Ria. A device-scoped balance would be farmable by clearing localStorage —
 * groups need no account by design, which is exactly why the reward economy
 * cannot live there (docs/11-REWARDS.md §6).
 *
 * One route, and it only reads. Earning happens in the services that already
 * handle expenses, settlements and ledger entries.
 */
router.use(requireAuth);

router.get("/", pointsController.getSummary);

module.exports = router;
