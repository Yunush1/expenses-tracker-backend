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

/**
 * Currency → minor-unit scale, and it is a **contract with the client**.
 *
 * The frontend holds the same table in its own `utils/money.js` and parses typed
 * amounts with it before they ever reach here. If the two disagree about a
 * currency, this server stores a number a hundred times off what the person typed
 * and nothing errors — so `frontend/tests/currencyContract.test.mjs` compares the
 * two files and fails if they drift. See docs/27-MULTI-CURRENCY.md §3.
 *
 * The values are ISO 4217 exponents.
 */
const MINOR_UNIT_SCALES = Object.freeze({
  /* South Asia */
  INR: 100,
  LKR: 100,
  NPR: 100,
  BDT: 100,
  PKR: 100,

  /* The reserve currencies */
  USD: 100,
  EUR: 100,
  GBP: 100,
  CHF: 100,
  CAD: 100,
  AUD: 100,
  NZD: 100,

  /* Where Indian groups actually travel */
  AED: 100,
  SAR: 100,
  QAR: 100,
  SGD: 100,
  MYR: 100,
  THB: 100,
  IDR: 100,
  PHP: 100,
  HKD: 100,
  CNY: 100,
  TRY: 100,
  ZAR: 100,
  RUB: 100,
  BRL: 100,
  MXN: 100,

  /* Zero decimal places — ¥1,000 is a thousand yen, not ten. */
  JPY: 1,
  KRW: 1,
  VND: 1,

  /* Three decimal places. Getting these wrong stores amounts ten times too
     small, which is why the list is validated rather than open. */
  KWD: 1000,
  BHD: 1000,
  OMR: 1000,
});

/** Every currency a group or ledger may be created in. */
const SUPPORTED_CURRENCIES = Object.freeze(Object.keys(MINOR_UNIT_SCALES));

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

/** Unambiguous symbols only; everything else is prefixed with its code. */
const CURRENCY_SYMBOLS = Object.freeze({
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  THB: "฿",
  PHP: "₱",
  VND: "₫",
  KRW: "₩",
  TRY: "₺",
  RUB: "₽",
  BDT: "৳",
  BRL: "R$",
  ZAR: "R",
  AUD: "A$",
  CAD: "C$",
  NZD: "NZ$",
  HKD: "HK$",
  SGD: "S$",
});

/**
 * Digit grouping follows the currency, not the app.
 *
 * `toLocaleString("en-IN", ...)` was hardcoded, which is right for rupees —
 * ₹12,34,567 is how a lakh is written and any other grouping reads as foreign.
 * It is wrong for everything else: it rendered dollars as $12,34,567.89. South
 * Asian currencies use the lakh/crore system; the rest group in thousands.
 */
const LAKH_GROUPED = new Set(["INR", "PKR", "BDT", "LKR", "NPR"]);
const localeFor = (currency) => (LAKH_GROUPED.has(currency) ? "en-IN" : "en-US");

/** Human-readable string, e.g. 123456 → "₹1,234.56". */
const formatMinor = (amountMinor, currency = DEFAULT_CURRENCY) => {
  const scale = scaleFor(currency);
  const decimals = String(scale).length - 1;
  const symbol =
    CURRENCY_SYMBOLS[currency] ?? (MINOR_UNIT_SCALES[currency] ? `${currency}\u00a0` : "");
  const major = Math.abs(amountMinor) / scale;
  const sign = amountMinor < 0 ? "-" : "";

  return `${sign}${symbol}${major.toLocaleString(localeFor(currency), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
};

module.exports = {
  MINOR_UNIT_SCALES,
  SUPPORTED_CURRENCIES,
  scaleFor,
  toMinor,
  toMajor,
  assertMinor,
  sumMinor,
  formatMinor,
};
