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

module.exports = {
  ApiError,
  BadRequestError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  GoneError,
};
