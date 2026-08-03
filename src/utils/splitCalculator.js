const { ApiError, BadRequestError } = require("../errors");
const { ERROR_CODES, SPLIT_TYPES, LIMITS } = require("../constants");
const { assertMinor, toMinor, formatMinor } = require("./money");

/**
 * Splits an amount across participants so that the shares sum to the amount EXACTLY.
 *
 * ₹10 three ways is 333.33 paise each, and rounding each share down loses a paise —
 * repeat that a few hundred times and the group's balances stop summing to zero.
 * The largest-remainder method distributes the leftover minor units (always fewer
 * than the participant count) one each to the participants with the largest discarded
 * fractions, breaking ties on member id so the same expense always produces the same
 * shares regardless of the order the client sent them in.
 *
 * Four strategies share that one remainder rule:
 *
 *   EQUAL       every participant weighted 1
 *   SHARES      caller-supplied integer weights ("Ravi counts double, he had the suite")
 *   PERCENTAGE  weights are centipercent and must total exactly 100%
 *   EXACT       no distribution at all — the caller states every share and it must
 *               already add up
 *
 * See docs/05-ALGORITHMS.md §2.
 */

/** Shared entry validation: every strategy needs a sane amount and participant list. */
const validateInputs = (amountMinor, participantIds) => {
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

  return ids;
};

/**
 * Largest-remainder distribution of `amountMinor` in proportion to integer weights.
 *
 * All arithmetic is integer: the exact share of participant i is
 * `amountMinor × wᵢ / W`, so `floor` gives the guaranteed part and the division
 * remainder `(amountMinor × wᵢ) mod W` ranks who deserves the leftover units —
 * no float ever represents a share.
 */
const splitByWeights = (amountMinor, participantIds, weightByMemberId) => {
  const ids = validateInputs(amountMinor, participantIds);

  // Sort by id, not by array position: deterministic across requests and re-edits.
  const ordered = [...ids].sort();

  const entries = ordered.map((memberId) => {
    const weight = weightByMemberId.get(memberId);

    if (!Number.isInteger(weight) || weight < 0) {
      throw new BadRequestError(
        "Every participant needs a whole, non-negative share weight",
        ERROR_CODES.INVALID_SPLIT
      );
    }

    return { memberId, weight };
  });

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);

  if (totalWeight <= 0) {
    throw new BadRequestError(
      "The split weights must add up to more than zero",
      ERROR_CODES.INVALID_SPLIT
    );
  }

  const allocations = entries.map(({ memberId, weight }) => {
    const product = amountMinor * weight;

    return {
      memberId,
      amountMinor: Math.floor(product / totalWeight),
      // The fraction that floor() discarded, kept as an integer numerator over
      // totalWeight so it can be compared without dividing.
      discarded: product % totalWeight,
    };
  });

  const allocated = allocations.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const leftover = amountMinor - allocated;

  // Always fewer leftover units than participants, so one pass in rank order is enough.
  const ranked = [...allocations].sort(
    (a, b) => b.discarded - a.discarded || (a.memberId < b.memberId ? -1 : 1)
  );

  for (let index = 0; index < leftover; index += 1) {
    ranked[index].amountMinor += 1;
  }

  const shares = allocations.map(({ memberId, amountMinor: share }) => ({
    memberId,
    amountMinor: share,
  }));

  assertSharesBalance(shares, amountMinor);

  return shares;
};

/**
 * Equal split — every participant carries weight 1, which makes the discarded
 * fraction identical for everyone and hands the leftover paise to the first ids in
 * sorted order. Kept as its own export because it is the overwhelmingly common case.
 */
const splitEqually = (amountMinor, participantIds) => {
  const ids = validateInputs(amountMinor, participantIds);
  return splitByWeights(amountMinor, ids, new Map(ids.map((memberId) => [memberId, 1])));
};

/**
 * Exact split — the caller has already decided every share, so there is nothing to
 * distribute. The only question is whether the numbers add up, and if they do not
 * the error says by how much, because "invalid split" leaves the user hunting.
 */
const splitExactly = (amountMinor, participantIds, minorByMemberId, currency) => {
  const ids = validateInputs(amountMinor, participantIds);

  const shares = [...ids].sort().map((memberId) => {
    const share = minorByMemberId.get(memberId);
    assertMinor(share, "Share");

    if (share <= 0) {
      throw new BadRequestError(
        "Every participant's exact amount must be greater than zero",
        ERROR_CODES.INVALID_SPLIT
      );
    }

    return { memberId, amountMinor: share };
  });

  const total = shares.reduce((sum, share) => sum + share.amountMinor, 0);

  if (total !== amountMinor) {
    const difference = amountMinor - total;
    const verb = difference > 0 ? "short by" : "over by";

    throw new BadRequestError(
      `The exact amounts add up to ${formatMinor(total, currency)} but the expense is ` +
        `${formatMinor(amountMinor, currency)} — ${verb} ${formatMinor(Math.abs(difference), currency)}`,
      ERROR_CODES.INVALID_SPLIT
    );
  }

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

/**
 * Turns the `[{ memberId, value }]` list into a lookup, rejecting anything that does
 * not describe exactly the participant set. A split value for someone who is not on
 * the expense — or a participant with no value — is a client bug that would otherwise
 * surface much later as a share that quietly went missing.
 */
const toValueMap = (splitValues, participantIds, splitType) => {
  if (!Array.isArray(splitValues) || splitValues.length === 0) {
    throw new BadRequestError(
      `A ${splitType} split needs a value for each participant`,
      ERROR_CODES.INVALID_SPLIT
    );
  }

  const byMemberId = new Map();

  for (const entry of splitValues) {
    const memberId = String(entry?.memberId ?? "");

    if (!memberId) {
      throw new BadRequestError("Each split value needs a member id", ERROR_CODES.INVALID_SPLIT);
    }

    if (byMemberId.has(memberId)) {
      throw new BadRequestError(
        "A participant can only appear once in the split",
        ERROR_CODES.INVALID_SPLIT
      );
    }

    byMemberId.set(memberId, entry.value);
  }

  const participants = new Set(participantIds.map(String));

  if (participants.size !== byMemberId.size) {
    throw new BadRequestError(
      "The split must cover exactly the participants on this expense",
      ERROR_CODES.INVALID_SPLIT
    );
  }

  for (const memberId of participants) {
    if (!byMemberId.has(memberId)) {
      throw new BadRequestError(
        "Every participant needs a split value",
        ERROR_CODES.INVALID_SPLIT
      );
    }
  }

  return byMemberId;
};

/**
 * Client-supplied split values → the integer form stored on the expense.
 * Runs once, at the service boundary, for the same reason `toMinor` does: past this
 * point the whole pipeline is integers (see constants.SPLIT_VALUE_UNITS).
 */
const normalizeSplitValues = ({ splitType, splitValues, currency }) => {
  if (splitType === SPLIT_TYPES.EQUAL) return [];

  if (!Array.isArray(splitValues)) {
    throw new BadRequestError(
      `A ${splitType} split needs a value for each participant`,
      ERROR_CODES.INVALID_SPLIT
    );
  }

  return splitValues.map((entry) => {
    const memberId = String(entry?.memberId ?? "");
    const raw = typeof entry?.value === "string" ? Number(entry.value.trim()) : entry?.value;

    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new BadRequestError("Each split value must be a number", ERROR_CODES.INVALID_SPLIT);
    }

    switch (splitType) {
      case SPLIT_TYPES.EXACT:
        // toMinor already rejects zero, negatives and excess precision.
        return { memberId, value: toMinor(raw, currency) };

      case SPLIT_TYPES.PERCENTAGE: {
        if (raw <= 0 || raw > 100) {
          throw new BadRequestError(
            "Each percentage must be greater than 0 and at most 100",
            ERROR_CODES.INVALID_SPLIT
          );
        }

        const centi = Math.round(raw * 100);

        if (Math.abs(raw * 100 - centi) > 1e-6) {
          throw new BadRequestError(
            "A percentage can have at most 2 decimal places",
            ERROR_CODES.INVALID_SPLIT
          );
        }

        return { memberId, value: centi };
      }

      case SPLIT_TYPES.SHARES: {
        if (!Number.isInteger(raw) || raw < 1 || raw > LIMITS.MAX_SHARE_WEIGHT) {
          throw new BadRequestError(
            `Share weights must be whole numbers between 1 and ${LIMITS.MAX_SHARE_WEIGHT}`,
            ERROR_CODES.INVALID_SPLIT
          );
        }

        return { memberId, value: raw };
      }

      default:
        throw new BadRequestError(
          `Split type "${splitType}" is not supported`,
          ERROR_CODES.VALIDATION_ERROR
        );
    }
  });
};

/**
 * Dispatch point for the split strategies. `splitValues` carries the normalized
 * integers from `normalizeSplitValues` and is ignored for EQUAL.
 */
const calculateShares = ({
  splitType = SPLIT_TYPES.EQUAL,
  amountMinor,
  participantIds,
  splitValues = [],
  currency,
}) => {
  switch (splitType) {
    case SPLIT_TYPES.EQUAL:
      return splitEqually(amountMinor, participantIds);

    case SPLIT_TYPES.EXACT:
      return splitExactly(
        amountMinor,
        participantIds,
        toValueMap(splitValues, participantIds, splitType),
        currency
      );

    case SPLIT_TYPES.PERCENTAGE: {
      const byMemberId = toValueMap(splitValues, participantIds, splitType);
      const total = [...byMemberId.values()].reduce((sum, value) => sum + value, 0);

      if (total !== LIMITS.PERCENT_TOTAL_CENTI) {
        throw new BadRequestError(
          `The percentages add up to ${(total / 100).toFixed(2)}% — they must total exactly 100%`,
          ERROR_CODES.INVALID_SPLIT
        );
      }

      return splitByWeights(amountMinor, participantIds, byMemberId);
    }

    case SPLIT_TYPES.SHARES:
      return splitByWeights(
        amountMinor,
        participantIds,
        toValueMap(splitValues, participantIds, splitType)
      );

    default:
      throw new BadRequestError(
        `Split type "${splitType}" is not supported`,
        ERROR_CODES.VALIDATION_ERROR
      );
  }
};

module.exports = {
  splitEqually,
  splitByWeights,
  splitExactly,
  normalizeSplitValues,
  calculateShares,
  assertSharesBalance,
};
