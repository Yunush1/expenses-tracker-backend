const asyncHandler = require("../middlewares/asyncHandler");
const shareLinkService = require("../services/shareLinkService");
const { ok, created } = require("../utils/apiResponse");

/**
 * Short links for the calculators (models/shareLink.js).
 *
 * Two endpoints, no account, no device scoping, and nothing here reads or writes
 * anything belonging to a group. It is a lookup table with a create.
 */

exports.create = asyncHandler(async (req, res) => {
  const link = await shareLinkService.create(req.body);

  /**
   * 201 even when an identical payload already had a code.
   *
   * The caller asked for a link to exist and one does; that a previous tap made
   * the same row is our bookkeeping, not their result. `reused` is reported for
   * anyone who cares, and no client needs to branch on it.
   */
  return created(res, link, "Share link created");
});

exports.resolve = asyncHandler(async (req, res) => {
  const link = await shareLinkService.resolve(req.params.code);

  /**
   * A code's payload never changes — a different payload is a different code — so
   * this is genuinely immutable and can be cached hard. Five minutes rather than
   * a year only because `hits` and the expiry refresh are worth keeping roughly
   * honest, and because a link posted in a group chat is opened by twenty people
   * inside a minute, which is the burst this is actually protecting against.
   */
  res.set("Cache-Control", "public, max-age=300");

  return ok(res, link, "Share link");
});
