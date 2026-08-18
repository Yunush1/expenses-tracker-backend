const express = require("express");
const groupRoutes = require("./groupRoutes");
const pushRoutes = require("./pushRoutes");
const authRoutes = require("./authRoutes");
const ledgerRoutes = require("./ledgerRoutes");
const aiRoutes = require("./aiRoutes");
const pointsRoutes = require("./pointsRoutes");
const referralRoutes = require("./referralRoutes");
const sheetRoutes = require("./sheetRoutes");
const blogRoutes = require("./blogRoutes");

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
/** Invite links and their multi-level rewards (docs/12-REFERRALS.md). */
router.use("/referrals", referralRoutes);
/**
 * Free-form expense grids, shared by email (docs/20-EXPENSE-SHEETS.md).
 *
 * The second account-gated resource in this API, and the only one that is
 * *partly* public: reads go through `optionalAuth` so a sheet set to "anyone with
 * the link" opens with no account at all, while every write requires one. The
 * split is per-route rather than at this mount — see sheetRoutes for why that
 * asymmetry is deliberate and which direction each half fails in.
 */
router.use("/sheets", sheetRoutes);
/**
 * The blog (docs/23-BLOG.md).
 *
 * The only router here whose *reads* are meant to be crawled. Everything else in
 * this file is either behind an account or behind a capability URL and carries
 * `noindex`; these pages exist to be found by strangers, which is why app.js
 * exempts this prefix from the blanket `X-Robots-Tag` it sets on everything else.
 *
 * Writes are gated by `requireAuth` + `requireAdmin` on the `/admin` prefix
 * inside the router, keyed off the `ADMIN_EMAILS` allowlist.
 */
router.use("/blog", blogRoutes);

module.exports = router;
