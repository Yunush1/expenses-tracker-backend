const { calculateShares } = require("./splitCalculator");
const { SPLIT_TYPES } = require("../constants");

/**
 * Folding one member's history into another's.
 *
 * Needed because a single `deviceId` per member meant one person opening the group
 * on a phone, a laptop and a tablet became three members with three balances. The
 * fix stops new duplicates; this repairs the ones already recorded.
 *
 * Pure: every function here takes plain documents and returns plain documents, so
 * the invariants — `Σ shares === amountMinor`, `Σ percentages === 100%`, no
 * settlement pointing at itself — can be tested without a database.
 */

const id = (value) => String(value);

/**
 * Rewrites ids in a list, summing any rows that collide as a result.
 *
 * Collisions are the whole difficulty: when both members were participants in the
 * same expense, remapping leaves two rows for one person. Two rows would still add
 * up — the balance aggregation groups by member — but `participantCount` would lie
 * and an edit would round-trip through a calculator that expects one row each.
 * Summing is correct for every field this is used on: minor units, centipercent and
 * share weights all add.
 */
const coalesceBy = (rows, field, fromId, intoId) => {
  const merged = [];
  const indexByMember = new Map();

  for (const row of rows) {
    const memberId = id(row.memberId) === fromId ? intoId : id(row.memberId);
    const at = indexByMember.get(memberId);

    if (at === undefined) {
      indexByMember.set(memberId, merged.length);
      merged.push({ memberId, [field]: row[field] });
    } else {
      merged[at][field] += row[field];
    }
  }

  return merged;
};

/** Participants after the duplicate is folded away, in their original order. */
const mergedParticipants = (shares, fromId, intoId) => {
  const ids = [];

  for (const share of shares) {
    const memberId = id(share.memberId) === fromId ? intoId : id(share.memberId);
    if (!ids.includes(memberId)) ids.push(memberId);
  }

  return ids;
};

/**
 * @returns {{ changed: boolean, resplit: boolean, patch: object }} — patch is empty
 *          when this expense never referenced the member being merged away.
 *
 * The shares are **recalculated**, not patched.
 *
 * That distinction is the whole correctness of a merge. ₹90 split equally between
 * U1, U2 and U3 — where U2 is really U1's second phone — was only ever eaten by two
 * people. Simply moving U2's ₹30 onto U1 leaves U1 paying ₹60 for half a dinner:
 * the phantom's share, now billed to a real person. Re-running the split over the
 * two remaining participants gives ₹45 each, which is what the expense would have
 * been had the duplicate never existed.
 *
 * Running it through `calculateShares` means each split type does the right thing
 * for its own reason:
 *
 *   EQUAL       nothing was ever typed — the division came from the participant
 *               list, so a wrong list means a wrong division. Redo it.
 *   EXACT       amounts were stated per row; one person holding two rows owes their
 *               sum. The summed values are the split.
 *   PERCENTAGE  same, and the summed centipercent still totals exactly 100%.
 *   SHARES      weights are deliberate. Someone who wants to carry two portions
 *               says so here, and summing preserves that.
 *
 * `Σ shares === amountMinor` is re-asserted by the calculator either way, so the
 * expense total never moves — only who owes what inside it.
 */
const remapExpense = (expense, fromId, intoId) => {
  const from = id(fromId);
  const into = id(intoId);

  const touchesMember =
    id(expense.paidBy) === from ||
    id(expense.createdByMemberId) === from ||
    id(expense.deletedByMemberId) === from ||
    (expense.shares || []).some((share) => id(share.memberId) === from) ||
    (expense.splitValues || []).some((value) => id(value.memberId) === from);

  if (!touchesMember) return { changed: false, resplit: false, patch: {} };

  const participantIds = mergedParticipants(expense.shares || [], from, into);
  const splitValues = coalesceBy(expense.splitValues || [], "value", from, into);

  // True when the duplicate and the survivor were both participants — the only case
  // where anybody's share actually changes.
  const resplit = participantIds.length < (expense.shares || []).length;

  const patch = {
    shares: calculateShares({
      splitType: expense.splitType || SPLIT_TYPES.EQUAL,
      amountMinor: expense.amountMinor,
      participantIds,
      splitValues,
      currency: expense.currencyCode,
    }),
    splitValues,
  };

  if (id(expense.paidBy) === from) patch.paidBy = into;
  if (id(expense.createdByMemberId) === from) patch.createdByMemberId = into;
  if (expense.deletedByMemberId && id(expense.deletedByMemberId) === from) {
    patch.deletedByMemberId = into;
  }

  return { changed: true, resplit, patch };
};

/**
 * @returns {{ action: "none" | "update" | "drop", patch?: object }}
 *
 * "drop" is for a settlement between the two members being merged: after the merge
 * it would record a person paying themselves, which is not a payment. Dropping it
 * is also balance-neutral — it added and subtracted the same amount for the same
 * person — so the ledger is unchanged, and the caller records what it removed in
 * the activity log so the timeline stays truthful.
 */
const remapSettlement = (settlement, fromId, intoId) => {
  const from = id(fromId);
  const into = id(intoId);

  const nextFrom = id(settlement.fromMemberId) === from ? into : id(settlement.fromMemberId);
  const nextTo = id(settlement.toMemberId) === from ? into : id(settlement.toMemberId);

  const touchesMember =
    id(settlement.fromMemberId) === from ||
    id(settlement.toMemberId) === from ||
    id(settlement.recordedByMemberId) === from;

  if (!touchesMember) return { action: "none" };
  if (nextFrom === nextTo) return { action: "drop" };

  const patch = { fromMemberId: nextFrom, toMemberId: nextTo };
  if (id(settlement.recordedByMemberId) === from) patch.recordedByMemberId = into;

  return { action: "update", patch };
};

/**
 * Sanity check run on the merged expense before it is written. The whole point of
 * a merge is that no money moves, so the totals it produces must match the totals
 * it started with.
 */
const assertExpenseIntact = (expense, patch) => {
  const total = patch.shares.reduce((sum, share) => sum + share.amountMinor, 0);

  if (total !== expense.amountMinor) {
    throw new Error(
      `Merge would unbalance expense ${id(expense._id)}: shares total ${total}, expense is ${expense.amountMinor}`
    );
  }

  const before = new Set((expense.shares || []).map((share) => id(share.memberId)));
  const after = new Set(patch.shares.map((share) => share.memberId));

  if (after.size > before.size) {
    throw new Error(`Merge added a participant to expense ${id(expense._id)}`);
  }

  return true;
};

module.exports = {
  coalesceBy,
  mergedParticipants,
  remapExpense,
  remapSettlement,
  assertExpenseIntact,
};
