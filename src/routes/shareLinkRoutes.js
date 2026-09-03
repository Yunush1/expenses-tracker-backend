const express = require("express");

const validate = require("../middlewares/validate");
const { shareLinkLimiter } = require("../middlewares/rateLimiter");
const shareLinkController = require("../controllers/shareLinkController");
const {
  createShareLink,
  updateShareLink,
  shareCodeParams,
} = require("../validators/shareLinkValidators");

const router = express.Router();

/**
 * `POST /api/share-links` — turn a calculator's encoded state into `/s/<code>`.
 *
 * Public and account-free, like the exchange rates above it: the calculators have
 * no account, no group and no device identity, and there is nothing here to scope
 * a link to. What stops it being an open blob store is the payload pattern in the
 * validator plus the limiter — see both for the reasoning.
 */
router.post("/", shareLinkLimiter, validate(createShareLink), shareLinkController.create);

/**
 * `PATCH /api/share-links/:code` — the same link, new numbers.
 *
 * Behind the limiter like the create, because it is the same act: a person
 * pressing Share on a calculation they have changed. Authorised by the owner key
 * in the body and by nothing else — there is no account here to check it against,
 * which is the trade the whole feature is built on (models/shareLink.js).
 *
 * The params are validated before the body so a malformed code is "not a share
 * link" rather than a complaint about a key nobody was going to check.
 */
router.patch(
  "/:code",
  shareLinkLimiter,
  validate(shareCodeParams, "params"),
  validate(updateShareLink),
  shareLinkController.update
);

/**
 * `GET /api/share-links/:code` — the payload back.
 *
 * Not behind the limiter. This is the read a shared link performs, so twenty
 * people opening the same message in the same minute is the *normal* case, and a
 * limiter here would refuse the exact traffic the feature exists to serve. It is
 * a cached, indexed lookup returning a string the caller already has a URL for.
 */
router.get("/:code", validate(shareCodeParams, "params"), shareLinkController.resolve);

module.exports = router;
