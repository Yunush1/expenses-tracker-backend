const { z } = require("zod");

/**
 * An optional window for the **spending** figures on a balance read.
 *
 * It does not scope the balances themselves — see expenseRepository.aggregateTotals
 * for why it must not. Omit both and the response is exactly what it always was.
 */
const balancesQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

module.exports = { balancesQuery };
