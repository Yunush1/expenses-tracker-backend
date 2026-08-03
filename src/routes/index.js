const express = require("express");
const groupRoutes = require("./groupRoutes");

const router = express.Router();

router.use("/groups", groupRoutes);

module.exports = router;
