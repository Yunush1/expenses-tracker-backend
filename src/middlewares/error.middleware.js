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

  if (err instanceof ApiError) {
    ({ statusCode, code, message, errors } = err);
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
  if (!config.isProduction && statusCode >= 500) body.stack = err.stack;

  return res.status(statusCode).json(body);
};
