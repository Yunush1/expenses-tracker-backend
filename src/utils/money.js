const { BadRequestError } = require("../errors");
const { ERROR_CODES, LIMITS, DEFAULT_CURRENCY } = require("../constants");

/**
 * Money is stored, transported and computed as INTEGER MINOR UNITS (paise for INR).
 *
 * Floats cannot represent decimal fractions exactly — `0.1 + 0.2 === 0.30000000000000004`
 * — so float money drifts, and drifted balances stop summing to zero, which makes
 * settlement suggestions unpayable. Conversion happens at exactly two boundaries:
 * `toMinor` on the way in, `toMajor` on the way out. Nothing between them uses floats.
 *
 * See docs/05-ALGORITHMS.md §1.
 */

const MINOR_UNIT_SCALES = Object.freeze({
  INR: 100,
  USD: 100,
  EUR: 100,
  GBP: 100,
  JPY: 1,
});

const scaleFor = (currency = DEFAULT_CURRENCY) => MINOR_UNIT_SCALES[currency] ?? 100;

/**
 * Parse a user-supplied major-unit amount into integer minor units.
 * Rejects anything that is not a clean, positive, correctly-scaled amount.
 */
const toMinor = (value, currency = DEFAULT_CURRENCY) => {
  const numeric = typeof value === "string" ? Number(value.trim()) : value;

  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    throw new BadRequestError("Amount must be a valid number", ERROR_CODES.INVALID_AMOUNT);
  }

  if (numeric <= 0) {
    throw new BadRequestError("Amount must be greater than zero", ERROR_CODES.INVALID_AMOUNT);
  }

  if (numeric > LIMITS.MAX_AMOUNT_MAJOR) {
    throw new BadRequestError(
      `Amount must not exceed ${LIMITS.MAX_AMOUNT_MAJOR.toLocaleString("en-IN")}`,
      ERROR_CODES.INVALID_AMOUNT
    );
  }

  const scale = scaleFor(currency);
  const scaled = numeric * scale;

  // 12.34 * 100 === 1233.9999999999998, so round once here and validate that the
  // rounding did not silently discard precision the user actually typed.
  const rounded = Math.round(scaled);

  if (Math.abs(scaled - rounded) > 1e-6) {
    const decimals = String(scale).length - 1;
    throw new BadRequestError(
      `Amount cannot have more than ${decimals} decimal place(s)`,
      ERROR_CODES.INVALID_AMOUNT
    );
  }

  return rounded;
};

/** Integer minor units → major-unit number, for display only. */
const toMajor = (amountMinor, currency = DEFAULT_CURRENCY) => {
  assertMinor(amountMinor);
  return amountMinor / scaleFor(currency);
};

/** Throws unless `value` is a safe integer — guards every arithmetic entry point. */
const assertMinor = (value, label = "Amount") => {
  if (!Number.isInteger(value)) {
    throw new BadRequestError(`${label} must be an integer in minor units`, ERROR_CODES.INVALID_AMOUNT);
  }
  return value;
};

/** Integer-only sum. Throws rather than silently producing a float. */
const sumMinor = (values) => values.reduce((total, value) => total + assertMinor(value), 0);

const CURRENCY_SYMBOLS = Object.freeze({ INR: "₹", USD: "$", EUR: "€", GBP: "£", JPY: "¥" });

/** Human-readable string, e.g. 123456 → "₹1,234.56". */
const formatMinor = (amountMinor, currency = DEFAULT_CURRENCY) => {
  const scale = scaleFor(currency);
  const decimals = String(scale).length - 1;
  const symbol = CURRENCY_SYMBOLS[currency] ?? "";
  const major = Math.abs(amountMinor) / scale;
  const sign = amountMinor < 0 ? "-" : "";

  return `${sign}${symbol}${major.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
};

module.exports = {
  MINOR_UNIT_SCALES,
  scaleFor,
  toMinor,
  toMajor,
  assertMinor,
  sumMinor,
  formatMinor,
};
