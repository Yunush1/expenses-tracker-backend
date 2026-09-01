const asyncHandler = require("../middlewares/asyncHandler");
const balanceService = require("../services/balanceService");
const { toBalanceDTO } = require("../serializers");
const { ok } = require("../utils/apiResponse");

exports.getBalances = asyncHandler(async (req, res) => {
  const { group, member } = req;
  const currentMemberId = member?._id ?? null;

  /**
   * `from`/`to` add this month's spending beside each all-time balance; they never
   * narrow the balances. The group screen sends the current month so its
   * per-person header can agree with the rows underneath it, which are clamped to
   * the same window (docs/14-PERIODS.md §3).
   */
  const { from, to } = req.validatedQuery || {};

  const { balances, totals, isSettled } = await balanceService.computeBalances(group._id, {
    from,
    to,
  });

  const dtos = balances.map((balance) => toBalanceDTO(balance, currentMemberId, group.currency));
  const myBalance = currentMemberId
    ? dtos.find((balance) => balance.isYou) || null
    : null;

  return ok(res, { balances: dtos, myBalance, totals, isSettled });
});
