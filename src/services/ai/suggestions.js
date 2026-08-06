/**
 * What to ask Ria next.
 *
 * ## Why these are computed, not generated
 *
 * The obvious implementation asks the model for follow-ups. It costs another
 * call, and — worse — it suggests questions against data that may not exist:
 * "how much do you spend on rent?" to someone with no rent, which dead-ends on
 * "I can't see any rent". A suggestion that fails is worse than no suggestion,
 * because the user followed *our* prompt into the failure.
 *
 * Deriving them from the context instead means every offer is answerable by
 * construction: a question about settling up appears only when there is an
 * unsettled group, one about overdue loans only when something is overdue. Free,
 * instant, and correct.
 */

const ZERO = /^[^\d]*0(\.00)?$/;
const hasMoney = (formatted) => Boolean(formatted) && !ZERO.test(formatted);

/** Cheap similarity, to avoid offering back the question just asked. */
const normalise = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .join(" ");

const tooSimilar = (candidate, asked) => {
  const a = normalise(candidate);
  return asked.some((previous) => {
    const b = normalise(previous);
    if (!a || !b) return false;
    if (a === b) return true;
    // Share most significant words — "who owes me money" vs "who owes me the most".
    const aWords = new Set(a.split(" "));
    const bWords = b.split(" ");
    const overlap = bWords.filter((word) => aWords.has(word)).length;
    return overlap >= Math.max(2, Math.floor(bWords.length * 0.7));
  });
};

/**
 * @param context  the finance snapshot — the same one the model is given
 * @param asked    questions already asked this session, so nothing repeats
 * @param limit    how many to offer; three fits a drawer without becoming a menu
 */
const suggestFollowUps = (context, asked = [], limit = 3) => {
  if (!context?.hasAnything) return [];

  const candidates = [];
  const { ledger, groups = [] } = context;

  /* ---------------------------- personal ledger --------------------------- */

  if (ledger) {
    const owed = ledger.outstandingLoans.filter((loan) => loan.direction === "they owe you");
    const owing = ledger.outstandingLoans.filter((loan) => loan.direction === "you owe them");

    if (owed.length > 0) candidates.push("Who owes me money?");
    if (owed.some((loan) => loan.dueOn)) candidates.push("What's due soon?");
    if (owing.length > 0) candidates.push("What do I still owe people?");

    if (hasMoney(ledger.totals.spentThisMonth)) {
      candidates.push("What did I spend this month?");
      // Only worth asking when there is more than one category to compare.
      if ((ledger.spendByCategoryThisMonth || []).length > 1) {
        candidates.push("Where is most of my money going?");
      }
    }
  }

  /* -------------------------------- groups -------------------------------- */

  const unsettled = groups.filter((group) => group.settlementPlan && !group.settlementPlan.isSettled);

  if (unsettled.length === 1) {
    candidates.push(`How do I settle up in ${unsettled[0].name}?`);
  } else if (unsettled.length > 1) {
    candidates.push("Which group do I owe money in?");
    candidates.push("Who owes me the most across my groups?");
  }

  if (groups.length > 0) {
    const busiest = groups[0];
    candidates.push(`What have I paid for in ${busiest.name}?`);
    if (busiest.paymentsRecorded?.length > 0) {
      candidates.push(`Who has paid me back in ${busiest.name}?`);
    }
    if (busiest.totals?.expenseCount > 1) {
      candidates.push(`What is the biggest expense in ${busiest.name}?`);
    }
  }

  // Both worlds present: the one comparison the app can make and the UI cannot.
  if (ledger && groups.length > 0) {
    candidates.push("Am I owed more in my groups or personally?");
  }

  const seen = new Set();
  return candidates
    .filter((candidate) => {
      if (seen.has(candidate) || tooSimilar(candidate, asked)) return false;
      seen.add(candidate);
      return true;
    })
    .slice(0, limit);
};

module.exports = { suggestFollowUps };
