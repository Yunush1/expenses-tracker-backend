/** Uniform success envelope. The error shape is produced by error.middleware.js. */

const ok = (res, data = null, message = "OK") =>
  res.status(200).json({ success: true, message, data });

const created = (res, data = null, message = "Created") =>
  res.status(201).json({ success: true, message, data });

module.exports = { ok, created };
