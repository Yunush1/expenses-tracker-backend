const express = require("express");
const memberController = require("../controllers/memberController");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const requireAuth = require("../middlewares/requireAuth");
const optionalAuth = require("../middlewares/optionalAuth");
const { requireMember, requireCreator, requireActiveGroup } = require("../middlewares/groupAccess");
const {
  joinGroupSchema,
  addMemberSchema,
  renameMemberSchema,
  claimMemberSchema,
  linkDeviceSchema,
  mergeMemberSchema,
} = require("../validators/memberValidators");

// mergeParams so :inviteCode from the parent router stays visible here.
const router = express.Router({ mergeParams: true });

router.get("/", memberController.listMembers);

// Joining is the one write a non-member can perform — that is the whole no-auth model.
router.post(
  "/join",
  writeLimiter,
  requireActiveGroup,
  validate(joinGroupSchema),
  memberController.joinGroup
);

router.post(
  "/claim",
  writeLimiter,
  requireActiveGroup,
  validate(claimMemberSchema),
  memberController.claimMember
);

// Issued on a device that is already this member's...
router.post(
  "/link-code",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  memberController.createDeviceLinkCode
);

// ...and redeemed on one that is not, which is exactly why this cannot require a
// member. The code is the proof; the rate limiter and its ten-minute, single-use
// lifetime are what keep guessing impractical.
//
// `optionalAuth`, not `requireAuth`: redeeming a code must keep working with no
// account at all, but when the browser *is* signed in the same code also binds
// the member to it (docs/17-MEMBER-IDENTITY.md §6.2).
router.post(
  "/link",
  writeLimiter,
  requireActiveGroup,
  optionalAuth,
  validate(linkDeviceSchema),
  memberController.linkDevice
);

/**
 * Account linking (docs/17-MEMBER-IDENTITY.md §6.1).
 *
 * The status read takes `optionalAuth` because "are you signed in?" is half of
 * the answer and a signed-out caller deserves the honest one rather than a 401.
 * The write takes `requireAuth`: binding a member to an account with no verified
 * account is the one thing this must never do.
 *
 * Both take `requireMember`, so the caller has to already be this member on this
 * browser. That is what makes the confirmation meaningful — it supplies the fact
 * the server cannot infer on a shared machine.
 */
// `req.member` is already resolved by the parent router (groupRoutes mounts
// loadGroup + resolveMember for every /:inviteCode route), so a visitor reaches
// this with req.member === null and gets "NOT_A_MEMBER" rather than a 403.
router.get(
  "/account-link",
  requireActiveGroup,
  optionalAuth,
  memberController.accountLinkStatus
);

router.post(
  "/account-link",
  writeLimiter,
  requireActiveGroup,
  requireAuth,
  requireMember,
  memberController.linkAccount
);

router.delete(
  "/account-link",
  writeLimiter,
  requireActiveGroup,
  requireAuth,
  requireMember,
  memberController.unlinkAccount
);

router.post(
  "/",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(addMemberSchema),
  memberController.addMember
);

// Declared before "/:memberId" routes that could otherwise swallow it.
router.post(
  "/:memberId/merge",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(mergeMemberSchema),
  memberController.mergeMembers
);

router.patch(
  "/:memberId",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(renameMemberSchema),
  memberController.renameMember
);

router.delete(
  "/:memberId",
  writeLimiter,
  requireActiveGroup,
  requireCreator,
  memberController.removeMember
);

module.exports = router;
