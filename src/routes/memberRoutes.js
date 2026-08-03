const express = require("express");
const memberController = require("../controllers/memberController");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
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
router.post(
  "/link",
  writeLimiter,
  requireActiveGroup,
  validate(linkDeviceSchema),
  memberController.linkDevice
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
