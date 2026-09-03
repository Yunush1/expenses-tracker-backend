const asyncHandler = require("../middlewares/asyncHandler");
const shareLinkService = require("../services/shareLinkService");
const { ok, created } = require("../utils/apiResponse");
const { getIo } = require("../realtime/io");

/**
 * Short links for the calculators (models/shareLink.js).
 *
 * Three endpoints, no account, no device scoping, and nothing here reads or
 * writes anything belonging to a group. The code is the capability: holding it is
 * permission to read and to write, which is the same posture as a group invite
 * link and is spelled out where people can read it (models/shareLink.js).
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

exports.update = asyncHandler(async (req, res) => {
  const link = await shareLinkService.update({ code: req.params.code, ...req.body });

  /**
   * Anyone subscribed to this link gets the update instantly. The room name is
   * `sharelink:CODE` so the same code that the client holds is the key.
   *
   * `link.changed` tells the broadcast whether this was an actual edit (true) or
   * just a refresh (false — same payload, but the clock moved). The client can
   * decide whether to re-render: if the bytes are identical it can skip the
   * re-decode and stay where it was.
   *
   * The payload is sent as-is so clients that hold the code can read it without
   * a second GET. The rest of `link` (revision, updatedAt, data) are sent too, so
   * a reader can see what the server knows without a second round trip.
   */
  const io = getIo();
  if (io) {
    io.of("/").to(`sharelink:${req.params.code}`).emit("update", {
      code: req.params.code,
      payload: link.payload,
      revision: link.revision,
      data: link.data,
      changed: link.changed,
      updatedAt: link.updatedAt,
    });
  }

  return ok(res, link, link.changed ? "Share link updated" : "Share link unchanged");
});

exports.resolve = asyncHandler(async (req, res) => {
  const link = await shareLinkService.resolve(req.params.code);

  /**
   * `no-cache` means *revalidate*, not *do not store*, and the distinction is the
   * whole point here.
   *
   * This used to be `max-age=300` on the grounds that a code's payload never
   * changed. It changes now — that is what the owner key is for — and five
   * minutes of a stale copy is precisely the complaint the feature was built to
   * answer: somebody fixes a number, sends nothing, and the link goes on showing
   * the old one.
   *
   * The burst that justified caching is still handled. Express attaches an ETag
   * to this body, so twenty people opening the same chat message revalidate and
   * get 304s with no payload on the wire — and the moment the owner edits, the
   * ETag changes and the next open sees it.
   */
  res.set("Cache-Control", "no-cache");

  return ok(res, link, "Share link");
});
