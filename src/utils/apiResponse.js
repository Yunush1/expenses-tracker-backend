/** Uniform success envelope. The error shape is produced by error.middleware.js. */

const ok = (res, data = null, message = "Fetched successfully") =>
  res.status(200).json({ success: true, message, data });

const created = (res, data = null, message = "Created successfully") =>
  res.status(201).json({ success: true, message, data });

/**
 * Taken, but not done — the request exists and somebody else has to act on it.
 *
 * 202 rather than 201 for a join into a private group: nothing was created that
 * the caller asked for. They asked to join and are not in the group, and a 201
 * with a member-shaped absence is exactly the sort of thing a client reads as
 * success (docs/13-JOIN-APPROVAL.md §3).
 */
const accepted = (res, data = null, message = "Request received") =>
  res.status(202).json({ success: true, message, data });

module.exports = { ok, created, accepted };
