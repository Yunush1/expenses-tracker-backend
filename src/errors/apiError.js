const { ERROR_CODES } = require("../constants");

/**
 * Base class for every error the API deliberately returns to a client.
 * Anything that is *not* an ApiError is treated as an unexpected 500 and its
 * details are kept out of the response body.
 */
class ApiError extends Error {
  constructor(message = "Something went wrong", statusCode = 500, code = ERROR_CODES.INTERNAL_ERROR, errors = []) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;
