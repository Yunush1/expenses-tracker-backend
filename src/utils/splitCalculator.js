const { ApiError, BadRequestError } = require("../errors");
const { ERROR_CODES, SPLIT_TYPES } = require("../constants");
const { assertMinor } = require("./money");

/**
 * Splits an amount across participants so that the shares sum to the amount EXACTLY.
 *
 * ₹10 three ways is 333.33 paise each, and rounding each share down loses a paise —
 * repeat that a few hundred times and the group's balances stop summing to zero.
 * The largest-remainder method distributes the leftover minor units (always fewer
 * than the participant count) one each to the first `remainder` participants, in a
 * stable order sorted by member id so the same expense always produces the same
 * shares regardless of the order the client sent them in.
 *
 * See docs/05-ALGORITHMS.md §2.
 */

const splitEqually = (amountMinor, participantIds) => {
  assertMinor(amountMinor);

  if (amountMinor <= 0) {
    throw new BadRequestError("Amount must be greater than zero", ERROR_CODES.INVALID_AMOUNT);
  }

  const ids = participantIds.map(String);

  if (ids.length === 0) {
    throw new BadRequestError("At least one participant is required", ERROR_CODES.INVALID_PARTICIPANTS);
  }

  if (new Set(ids).size !== ids.length) {
    throw new BadRequestError("Participants must be unique", ERROR_CODES.INVALID_PARTICIPANTS);
  }

  const count = ids.length;
  const base = Math.floor(amountMinor / count);
  const remainder = amountMinor - base * count;

  // Sort by id, not by array position: deterministic across requests and re-edits.
  const ordered = [...ids].sort();

  const shares = ordered.map((memberId, index) => ({
    memberId,
    amountMinor: base + (index < remainder ? 1 : 0),
  }));

  assertSharesBalance(shares, amountMinor);

  return shares;
};

/**
 * The post-condition that makes every downstream balance trustworthy.
 * Throws rather than persisting — a silently unbalanced expense is worse than a
 * failed request, because it corrupts every balance computed from then on.
 */
const assertSharesBalance = (shares, amountMinor) => {
  const total = shares.reduce((sum, share) => sum + assertMinor(share.amountMinor), 0);

  if (total !== amountMinor) {
    throw new ApiError(
      `Split integrity check failed: shares total ${total} but expense is ${amountMinor}`,
      500,
      ERROR_CODES.INTERNAL_ERROR
    );
  }

  return true;
};

/** Dispatch point for future split strategies (EXACT, PERCENTAGE, SHARES). */
const calculateShares = ({ splitType = SPLIT_TYPES.EQUAL, amountMinor, participantIds }) => {
  switch (splitType) {
    case SPLIT_TYPES.EQUAL:
      return splitEqually(amountMinor, participantIds);
    default:
      throw new BadRequestError(
        `Split type "${splitType}" is not supported yet`,
        ERROR_CODES.VALIDATION_ERROR
      );
  }
};

module.exports = { splitEqually, calculateShares, assertSharesBalance };
