const express = require("express");

const authController = require("../controllers/authController");
const requireAuth = require("../middlewares/requireAuth");

const router = express.Router();

/**
 * Accounts exist for the personal ledger and nothing else (docs/09-AUTH.md §1).
 *
 * Note what is absent: no register, no login, no logout, no password reset, no
 * refresh. Firebase owns every one of those, and duplicating any of them here
 * would mean this server holding a credential — which is precisely what
 * delegating to Firebase avoids. What is left is "verify the token I already
 * have, and tell me who that is".
 */

/** Public — the client asks before deciding whether to render a sign-in button. */
router.get("/status", authController.getStatus);

router.get("/me", requireAuth, authController.getMe);

/**
 * Recovering group access after clearing browser storage.
 *
 * The account is the proof: a member row carrying a device id that belongs to
 * this account, and to no other, was used by a browser this person was signed
 * into. Ambiguous devices are skipped and fall back to asking a member.
 */
router.get("/groups/recoverable", requireAuth, authController.getRecoverableGroups);
router.post("/groups/restore", requireAuth, authController.restoreGroups);

module.exports = router;
