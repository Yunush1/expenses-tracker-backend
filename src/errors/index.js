const { ERROR_CODES } = require("../constants");
const ApiError = require("./apiError");

class BadRequestError extends ApiError {
  constructor(message = "Bad request", code = ERROR_CODES.VALIDATION_ERROR, errors = []) {
    super(message, 400, code, errors);
  }
}

class ValidationError extends ApiError {
  constructor(message = "Validation failed", errors = []) {
    super(message, 400, ERROR_CODES.VALIDATION_ERROR, errors);
  }
}

/**
 * 401, not 403. The distinction is load-bearing for the client: 401 means "sign
 * in (again)" and is the cue to refresh the ID token and retry, while 403 means
 * "signed in, still not allowed" and retrying is pointless. Firebase tokens
 * expire hourly, so this fires in normal operation and the client must handle it
 * as routine rather than as a failure — see docs/09-AUTH.md §3.
 */
class UnauthorizedError extends ApiError {
  constructor(message = "Sign in to continue", code = ERROR_CODES.UNAUTHENTICATED) {
    super(message, 401, code);
  }
}

class ForbiddenError extends ApiError {
  constructor(message = "Not allowed", code = ERROR_CODES.NOT_A_MEMBER) {
    super(message, 403, code);
  }
}

class NotFoundError extends ApiError {
  constructor(message = "Not found", code = ERROR_CODES.GROUP_NOT_FOUND) {
    super(message, 404, code);
  }
}

class ConflictError extends ApiError {
  constructor(message = "Conflict", code = ERROR_CODES.DUPLICATE, errors = []) {
    super(message, 409, code, errors);
  }
}

class GoneError extends ApiError {
  constructor(message = "Resource no longer available", code = ERROR_CODES.GROUP_DELETED) {
    super(message, 410, code);
  }
}

/**
 * The body was larger than the route accepts.
 *
 * Thrown by the upload paths, and also produced by `error.middleware.js` when
 * body-parser refuses a stream before any handler sees it. Both need to arrive
 * at the client as the same thing: a 413 carrying a sentence a person can act on,
 * rather than the 500 "Something went wrong" that an unrecognised error becomes.
 */
class PayloadTooLargeError extends ApiError {
  constructor(message = "That upload is too large", code = ERROR_CODES.PAYLOAD_TOO_LARGE) {
    super(message, 413, code);
  }
}

/**
 * The feature exists but this deployment cannot serve it — Firebase is not
 * configured, so nothing can verify a token. Distinct from 500 because nothing
 * has failed, and distinct from 404 because the route is real: it tells an
 * operator to set credentials rather than sending a developer to hunt a bug.
 */
class ServiceUnavailableError extends ApiError {
  constructor(message = "This feature is not available", code = ERROR_CODES.FEATURE_UNAVAILABLE) {
    super(message, 503, code);
  }
}

module.exports = {
  ApiError,
  BadRequestError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  GoneError,
  PayloadTooLargeError,
  ServiceUnavailableError,
};
