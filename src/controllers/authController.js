const asyncHandler = require("../middlewares/asyncHandler");
const authService = require("../services/authService");
const { isAuthEnabled } = require("../config/firebase");
const { ok } = require("../utils/apiResponse");

/**
 * Whether this deployment can accept sign-ins at all.
 *
 * Deliberately public: the client needs to know before rendering a sign-in
 * button, and a button that leads to a 503 is worse than no button. Leaks
 * nothing — that Firebase is configured is already visible in the client bundle.
 */
exports.getStatus = asyncHandler(async (req, res) => ok(res, { enabled: isAuthEnabled() }));

/**
 * Who the caller is, according to their token.
 *
 * The round trip is the point: it proves the whole loop — the client obtained a
 * token, this server verified it, and a row exists. It is also what the client
 * calls on load to turn a Firebase session into an app identity, and the first
 * call for a new account is what creates the `User` (see authService).
 */
exports.getMe = asyncHandler(async (req, res) => ok(res, authService.toProfileDTO(req.user)));
