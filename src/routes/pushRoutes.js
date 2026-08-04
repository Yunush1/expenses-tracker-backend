const express = require("express");

const pushController = require("../controllers/pushController");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const { registerTokenSchema, preferencesSchema } = require("../validators/pushValidators");

const router = express.Router();

/**
 * Device-scoped, so mounted at the API root rather than under a group. The browser
 * re-registers on every load — tokens rotate without warning — which is why the
 * write limiter is the ordinary one rather than anything stricter.
 */

router.get("/status", pushController.getStatus);

router.post("/token", writeLimiter, validate(registerTokenSchema), pushController.registerToken);

router.delete("/token", writeLimiter, pushController.unregisterToken);

/**
 * The evening reminder, switched independently of expense alerts — so someone can
 * silence the nag without blocking the site, which would take the useful
 * notifications with it.
 */
router.get("/preferences", pushController.getPreferences);

router.patch(
  "/preferences",
  writeLimiter,
  validate(preferencesSchema),
  pushController.updatePreferences
);

module.exports = router;
