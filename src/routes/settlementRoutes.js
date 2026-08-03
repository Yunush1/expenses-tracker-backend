const express = require("express");
const settlementController = require("../controllers/settlementController");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const { requireMember, requireActiveGroup } = require("../middlewares/groupAccess");
const { createSettlementSchema } = require("../validators/settlementValidators");
const { paginationQuery } = require("../validators/common");

const router = express.Router({ mergeParams: true });

// Declared before "/" so it is not shadowed by the list route's path matching.
router.get("/suggestions", settlementController.getSuggestions);

router.get("/", validate(paginationQuery, "query"), settlementController.listSettlements);

router.post(
  "/",
  writeLimiter,
  requireActiveGroup,
  requireMember,
  validate(createSettlementSchema),
  settlementController.recordSettlement
);

module.exports = router;
