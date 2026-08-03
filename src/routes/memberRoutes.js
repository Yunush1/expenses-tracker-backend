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

router.post(
  "/",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(addMemberSchema),
  memberController.addMember
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
