const express = require("express");

const asyncHandler = require("../middlewares/asyncHandler");
const { getRates } = require("../services/exchangeRateService");

const router = express.Router();

/**
 * `GET /api/rates?base=INR` — today's exchange rates.
 *
 * Public and unauthenticated, deliberately: the calculators use it and they have
 * no account, no group and no device identity. It discloses nothing about anyone
 * — the response is the same for every caller — and it is the one endpoint here
 * whose answer is entirely somebody else's public data.
 *
 * It never fails. A provider outage returns the last known rates with
 * `stale: true`, and a cold start with the provider down returns an empty table,
 * because a page that lets somebody type a rate by hand is far better than a page
 * that will not load (see exchangeRateService for the whole argument).
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const payload = await getRates(req.query.base || "INR");

    /**
     * Cached at the edge for a few minutes, and `stale-while-revalidate` for an
     * hour after that.
     *
     * Rates move once a day, so this is generous rather than risky, and it keeps
     * a page that several people open at once from becoming several calls to
     * this server, let alone to the provider.
     */
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");

    res.json({ success: true, message: "Exchange rates", data: payload });
  })
);

module.exports = router;
