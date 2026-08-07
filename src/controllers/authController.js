const asyncHandler = require("../middlewares/asyncHandler");
const authService = require("../services/authService");
const groupRecoveryService = require("../services/groupRecoveryService");
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

/**
 * Groups this account can prove it belongs to but this browser has lost.
 *
 * Behind `requireAuth` because the account *is* the evidence — there is nothing
 * to look up without one (docs/13-JOIN-APPROVAL.md §11).
 */
exports.getRecoverableGroups = asyncHandler(async (req, res) =>
  ok(res, {
    groups: await groupRecoveryService.findRecoverable(req.user, req.deviceId),
  })
);

/**
 * Attach this browser to those memberships.
 *
 * A POST the user triggers, never a side effect of signing in: silently rejoining
 * somebody to four groups because they logged in is a surprising amount of reach,
 * and they may have left one of them on purpose.
 */
exports.restoreGroups = asyncHandler(async (req, res) =>
  ok(
    res,
    await groupRecoveryService.restore(req.user, req.deviceId, req.body?.memberIds || null),
    "Groups restored"
  )
);
