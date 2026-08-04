const express = require("express");
const groupRoutes = require("./groupRoutes");
const pushRoutes = require("./pushRoutes");

const router = express.Router();

router.use("/groups", groupRoutes);
// Device-scoped, not group-scoped: one browser, one token, every group it is in.
router.use("/push", pushRoutes);

module.exports = router;
