const express = require("express");

const referralController = require("../controllers/referralController");
const requireAuth = require("../middlewares/requireAuth");

const router = express.Router();

/**
 * Account-gated, like points — an invite code identifies an account, and there is
 * no device-scoped version of "who invited whom" that would not be trivially
 * resettable.
 *
 * Note the absence of a claim or redeem route: `referredBy` is written at account
 * creation and by nothing else. See docs/12-REFERRALS.md §4 for why an endpoint
 * that could attach an existing user to a downline is the one thing this feature
 * must not have.
 */
router.use(requireAuth);

router.get("/", referralController.getSummary);

module.exports = router;
