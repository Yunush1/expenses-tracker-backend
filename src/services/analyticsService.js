const expenseRepository = require("../repositories/expenseRepository");
const memberRepository = require("../repositories/memberRepository");
const entitlementService = require("./entitlementService");
const { toMajor } = require("../utils/money");
const { FEATURES, LEDGER_CATEGORIES, ERROR_CODES } = require("../constants");
const { NotFoundError } = require("../errors");

/**
 * Where the money went (docs/16-TODO.md §2.3, docs/22-MONETIZATION.md §14 step 2).
 *
 * ## Why this is worth building whether or not anything is ever sold
 *
 * Sixteen categories are already being inferred on every expense and shown to
 * nobody. This is the reason to open the app when *not* settling up — which is the
 * whole retention question — and the data, the enum, the inference and the period
 * filter all exist already.
 *
 * ## What is free and what is not
 *
 * The current month is free, for everybody, forever. Older months are part of the
 * group's plan. That split is deliberate rather than arbitrary: "what did we spend
 * this month" is the question somebody has while they are still in the group's
 * life, and the answer costs nothing to serve. "How has our spending moved over
 * two years" is a different, retrospective question, and it is the one worth
 * paying for.
 *
 * Nothing here is metered — it is an aggregation over rows the group already owns,
 * so it costs one indexed query however often it is asked.
 */

/** A slice with no name is still a slice. See categoryTotals in the repository. */
const UNCATEGORISED = "UNCATEGORISED";

/** Every category, so a caller can render a legend without a second source. */
const CATEGORY_KEYS = Object.freeze([...LEDGER_CATEGORIES, UNCATEGORISED]);

/**
 * Spend by category over a range, for the group or for one member.
 *
 * `from` and `to` are whole days and come from the period the client is looking
 * at, so this answers exactly the month on screen rather than a rolling window.
 */
const categoryBreakdown = async (group, { from, to, memberId } = {}) => {
  const entitlement = await entitlementService.forGroup(group._id);

  /**
   * The depth check happens before any query runs.
   *
   * Not for cost — the aggregation is cheap — but because the refusal has to be
   * the *whole* answer. Running it and then withholding the result would mean the
   * server had computed something it then pretended not to know, and the first
   * time someone adds a debug log the numbers leak.
   */
  entitlementService.assertWithinDepth(entitlement, FEATURES.CATEGORY_ANALYTICS, from, group);

  /**
   * A member id is validated against the group, not trusted from the query.
   *
   * The invite link is a capability URL, so "whose spending is this" must be a
   * member of *this* group — otherwise a caller could aim the breakdown at an id
   * from another group and learn whether it produced any rows.
   */
  let member = null;
  if (memberId) {
    member = await memberRepository.findById(group._id, memberId);
    if (!member) {
      throw new NotFoundError("That member is not in this group", ERROR_CODES.MEMBER_NOT_FOUND);
    }
  }

  const rows = await expenseRepository.categoryTotals(group._id, { from, to, memberId });

  const totalMinor = rows.reduce((sum, row) => sum + row.totalMinor, 0);
  const expenseCount = rows.reduce((sum, row) => sum + row.count, 0);

  return {
    /** Echoed back so a late response cannot be rendered under the wrong month. */
    from: from || null,
    to: to || null,
    scope: member ? "MEMBER" : "GROUP",
    member: member ? { id: String(member._id), name: member.name } : null,
    totalMinor,
    total: toMajor(totalMinor, group.currency),
    expenseCount,
    currency: group.currency,
    categories: rows.map((row) => ({
      category: row._id,
      totalMinor: row.totalMinor,
      total: toMajor(row.totalMinor, group.currency),
      count: row.count,
      /**
       * Rounded to whole percent, and computed here rather than in the browser so
       * every client draws the same chart. It is a label, never an input to
       * anything: the minor-unit integer beside it is the authoritative figure.
       */
      percent: totalMinor > 0 ? Math.round((row.totalMinor / totalMinor) * 100) : 0,
    })),
  };
};

module.exports = { categoryBreakdown, CATEGORY_KEYS, UNCATEGORISED };
