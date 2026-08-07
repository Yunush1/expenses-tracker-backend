const asyncHandler = require("../middlewares/asyncHandler");
const joinRequestService = require("../services/joinRequestService");
const { ok, created } = require("../utils/apiResponse");

/**
 * Asking to join by short code, and answering.
 *
 * The request and status routes are **unauthenticated by design** — the person
 * asking is not a member yet, so there is nothing to authenticate them with
 * except the device id they already send. Both are scoped to that device: you can
 * only read the status of a request your own browser made.
 *
 * Deciding sits inside the group router, behind `resolveMember`, so only somebody
 * already in the group can answer (docs/13-JOIN-APPROVAL.md §4).
 */

exports.createRequest = asyncHandler(async (req, res) => {
  const result = await joinRequestService.request({
    code: req.body.code,
    name: req.body.name,
    deviceId: req.deviceId,
    userAgent: req.get("User-Agent") || "",
  });

  return created(res, result);
});

/**
 * "That's me, I lost my browser." — a recovery request, not a new join.
 *
 * Unauthenticated like the join request above, and for the same reason: this
 * browser is not yet anybody in the group. What makes it safe is that it only
 * creates a *request* (docs/13-JOIN-APPROVAL.md §11).
 */
exports.claimMember = asyncHandler(async (req, res) =>
  created(
    res,
    await joinRequestService.requestClaim({
      group: req.group,
      memberId: req.params.memberId,
      deviceId: req.deviceId,
      userAgent: req.get("User-Agent") || "",
    }),
    "Waiting for a member to confirm"
  )
);

exports.getStatus = asyncHandler(async (req, res) =>
  ok(
    res,
    await joinRequestService.statusFor({
      requestId: req.params.requestId,
      deviceId: req.deviceId,
    })
  )
);

exports.cancel = asyncHandler(async (req, res) =>
  ok(
    res,
    await joinRequestService.cancel({
      requestId: req.params.requestId,
      deviceId: req.deviceId,
    })
  )
);

/* --------------------- inside a group, members only ---------------------- */

exports.listPending = asyncHandler(async (req, res) =>
  ok(res, { requests: await joinRequestService.listPending(req.group) })
);

exports.decide = asyncHandler(async (req, res) =>
  ok(
    res,
    await joinRequestService.decide({
      group: req.group,
      actor: req.member,
      requestId: req.params.requestId,
      approve: req.body.decision === "approve",
    })
  )
);
