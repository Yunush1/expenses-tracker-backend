const { ValidationError } = require("../errors");

/**
 * Runs a Zod schema against one part of the request and replaces it with the
 * parsed result, so controllers and services only ever see trusted, coerced data.
 */
const validate = (schema, source = "body") => (req, res, next) => {
  const result = schema.safeParse(req[source]);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join(".") || source,
      message: issue.message,
    }));

    return next(new ValidationError(errors[0]?.message || "Validation failed", errors));
  }

  // req.query is a getter in Express 5, so assign onto a writable holder instead.
  if (source === "query") {
    req.validatedQuery = result.data;
  } else {
    req[source] = result.data;
  }

  return next();
};

module.exports = validate;
