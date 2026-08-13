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

    /**
     * Structured context a client needs in order to *act* on the refusal, as
     * opposed to `errors`, which describes what was wrong with the request.
     *
     * Set by the thrower, emitted verbatim by error.middleware.js, and omitted
     * when empty. It exists because some refusals are themselves a screen rather
     * than a dead end: a 403 on a private sheet carries the sheet's title and
     * owner so the client can render "ask for access" without making a second
     * call for a resource it was just told it cannot read
     * (docs/20-EXPENSE-SHEETS.md §6).
     *
     * **Whatever goes in here is disclosed to a caller who has just been
     * refused.** Put in the minimum that makes the next step possible, and never
     * anything derived from the contents being protected.
     */
    this.details = null;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;
