const asyncHandler = require("../middlewares/asyncHandler");
const referralService = require("../services/referralService");
const { ok } = require("../utils/apiResponse");

/**
 * Invites.
 *
 * Read-only, and for the same reason the points controller is: there is nothing
 * a client should be able to assert here. The code is issued by the server, the
 * link between two accounts is written once at sign-up, and the payout is
 * triggered by the invited person using the app — none of which a request can
 * claim on its own behalf (docs/12-REFERRALS.md §4).
 */
exports.getSummary = asyncHandler(async (req, res) => ok(res, await referralService.stats(req.user)));
