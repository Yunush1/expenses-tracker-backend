const asyncHandler = require("../middlewares/asyncHandler");
const ledgerService = require("../services/ledgerService");
const { ok, created } = require("../utils/apiResponse");

/**
 * The personal ledger.
 *
 * Note what is missing from every signature: a ledger id. The owner comes from
 * the verified token (`req.user`, set by requireAuth), so there is exactly one
 * ledger a request can possibly mean. That is not a shortcut — a path parameter
 * would be an identifier a caller could tamper with, and this way there is
 * nothing to authorise beyond "is this person signed in".
 */

exports.getSummary = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.getSummary(req.user._id))
);

/** People this account can name on a loan — members of groups it belongs to. */
exports.listContacts = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.listContacts(req.user._id))
);

/**
 * Resolve a typed or scanned code to a name, so it can be confirmed before an
 * amount is committed to it. Answers "not found" rather than erroring — a typo
 * is the common case (docs/18-USER-CODE.md).
 */
exports.lookupCode = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.lookupByCode(req.user._id, req.query.code))
);

exports.listClaims = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.listIncomingClaims(req.user._id))
);

exports.acceptClaim = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.respondToClaim(req.user._id, req.params.id, true), "Added to your ledger")
);

exports.declineClaim = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.respondToClaim(req.user._id, req.params.id, false), "Declined")
);

exports.listEntries = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.listEntries(req.user._id, req.validatedQuery))
);

exports.createEntry = asyncHandler(async (req, res) =>
  created(res, await ledgerService.createEntry(req.user._id, req.body), "Entry added")
);

exports.updateEntry = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.updateEntry(req.user._id, req.params.id, req.body), "Entry updated")
);

exports.deleteEntry = asyncHandler(async (req, res) =>
  ok(res, await ledgerService.deleteEntry(req.user._id, req.params.id), "Entry deleted")
);

exports.addRepayment = asyncHandler(async (req, res) =>
  created(res, await ledgerService.addRepayment(req.user._id, req.params.id, req.body), "Repayment recorded")
);

exports.removeRepayment = asyncHandler(async (req, res) =>
  ok(
    res,
    await ledgerService.removeRepayment(req.user._id, req.params.id, req.params.repaymentId),
    "Repayment removed"
  )
);
