const asyncHandler = require("../middlewares/asyncHandler");
const balanceService = require("../services/balanceService");
const { toBalanceDTO } = require("../serializers");
const { ok } = require("../utils/apiResponse");

exports.getBalances = asyncHandler(async (req, res) => {
  const { group, member } = req;
  const currentMemberId = member?._id ?? null;

  const { balances, totals, isSettled } = await balanceService.computeBalances(group._id);

  const dtos = balances.map((balance) => toBalanceDTO(balance, currentMemberId, group.currency));
  const myBalance = currentMemberId
    ? dtos.find((balance) => balance.isYou) || null
    : null;

  return ok(res, { balances: dtos, myBalance, totals, isSettled });
});
