const { ApiError } = require("../errors");
const { ERROR_CODES } = require("../constants");
const config = require("../config/env");
const logger = require("../utils/logger");

/**
 * Terminal error handler. Produces the single failure envelope documented in
 * docs/04-API-SPEC.md and keeps internal details off the wire.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
module.exports = (err, req, res, next) => {
  let statusCode = 500;
  let code = ERROR_CODES.INTERNAL_ERROR;
  let message = "Something went wrong";
  let errors = [];
  /** Context the client acts on, when the thrower supplied any — see ApiError.details. */
  let details = null;

  if (err instanceof ApiError) {
    ({ statusCode, code, message, errors, details } = err);
  } else if (err?.name === "ValidationError" && err.errors) {
    // Mongoose schema validation
    statusCode = 400;
    code = ERROR_CODES.VALIDATION_ERROR;
    message = "Validation failed";
    errors = Object.entries(err.errors).map(([field, detail]) => ({
      field,
      message: detail.message,
    }));
  } else if (err?.name === "CastError") {
    statusCode = 400;
    code = ERROR_CODES.INVALID_ID;
    message = `Invalid value for "${err.path}"`;
  } else if (err?.code === 11000) {
    statusCode = 409;
    code = ERROR_CODES.DUPLICATE;
    message = "That record already exists";
  } else if (err?.type === "entity.too.large") {
    /**
     * body-parser refused the stream before any route ran.
     *
     * Without this branch it is an unrecognised error, which means a 500 and
     * "Something went wrong" — for the one failure whose cause is completely
     * knowable and whose fix is entirely in the caller's hands. The limits are
     * per-route and set in app.js.
     *
     * Note what this branch cannot catch: a body large enough for the *reverse
     * proxy* to reject is answered by nginx, in HTML, and never reaches Node at
     * all. If uploads fail with a 413 that has no JSON body, the limit that
     * needs raising is `client_max_body_size` — see deploy/nginx.conf.
     */
    statusCode = 413;
    code = ERROR_CODES.PAYLOAD_TOO_LARGE;
    message = "That upload is too large";
  } else if (err?.isCorsError) {
    statusCode = 403;
    code = ERROR_CODES.ORIGIN_NOT_ALLOWED;
    message = err.message;
  }

  if (statusCode >= 500) {
    logger.error(`[${req.method} ${req.originalUrl}] ${err.stack || err.message}`);
  } else {
    logger.warn(`[${req.method} ${req.originalUrl}] ${statusCode} ${code}: ${err.message}`);
  }

  const body = { success: false, message, code };
  if (errors.length > 0) body.errors = errors;
  // Only ever what the thrower explicitly put there; never inferred from `err`.
  if (details) body.details = details;
  if (!config.isProduction && statusCode >= 500) body.stack = err.stack;

  return res.status(statusCode).json(body);
};
