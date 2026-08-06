const express = require("express");
const groupRoutes = require("./groupRoutes");
const pushRoutes = require("./pushRoutes");
const authRoutes = require("./authRoutes");
const ledgerRoutes = require("./ledgerRoutes");
const aiRoutes = require("./aiRoutes");
const pointsRoutes = require("./pointsRoutes");

const router = express.Router();

router.use("/groups", groupRoutes);
// Device-scoped, not group-scoped: one browser, one token, every group it is in.
router.use("/push", pushRoutes);
/**
 * Accounts, for the personal ledger only (docs/09-AUTH.md §1). Mounted as its own
 * router rather than as global middleware precisely so that everything above stays
 * reachable without signing in — a group must never acquire a login by accident.
 */
router.use("/auth", authRoutes);
/**
 * The personal ledger — money lent, borrowed and spent alone
 * (docs/08-PERSONAL-LEDGER.md). The only account-gated resource in the API;
 * everything above it works with no sign-in at all.
 */
router.use("/ledger", ledgerRoutes);
/**
 * The finance assistant. Account-gated like the ledger, because it reads the
 * same private data and costs money per call (docs/10-AI-ASSISTANT.md §3).
 */
router.use("/ai", aiRoutes);
/** Reward points — earned from domain events, spent on Ria (docs/11-REWARDS.md). */
router.use("/points", pointsRoutes);

module.exports = router;
