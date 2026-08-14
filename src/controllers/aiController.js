const asyncHandler = require("../middlewares/asyncHandler");
const assistantService = require("../services/ai/assistantService");
const aiUsageService = require("../services/ai/aiUsageService");
const { ok } = require("../utils/apiResponse");

/**
 * The finance assistant.
 *
 * `req.user` comes from the verified token — the account is never read from the
 * body or a query parameter, so one person cannot ask questions about another's
 * money by editing a request.
 */

// The whole user, not just the id: the free allowance and the point price both
// depend on how old the account is (docs/10-AI-ASSISTANT.md §5).
exports.getStatus = asyncHandler(async (req, res) =>
  ok(res, await assistantService.status(req.user))
);

/**
 * What the assistant has cost this month, for whoever pays for it.
 *
 * Behind `requireAdmin` — it is an operational figure about the deployment, not
 * about the caller, and it is the one thing in this controller that is not the
 * requesting account's own data. See middlewares/requireAdmin.js for why the check
 * is not a comparison in the browser.
 */
exports.getUsage = asyncHandler(async (req, res) => ok(res, await aiUsageService.summary()));

/**
 * Starter questions for the empty state. Its own route rather than part of
 * `/status` because it builds the finance snapshot — worth doing when someone
 * opens the assistant, not on every page load.
 */
exports.getStarters = asyncHandler(async (req, res) =>
  ok(res, await assistantService.starters(req.user._id))
);

/**
 * The saved transcript, so reopening the drawer does not start from nothing.
 *
 * Scoped to `req.user._id` like everything else here — there is no path from a
 * request to another account's conversation.
 */
exports.getHistory = asyncHandler(async (req, res) =>
  ok(res, await assistantService.history(req.user._id))
);

exports.clearHistory = asyncHandler(async (req, res) =>
  ok(res, await assistantService.clearHistory(req.user._id), "Conversation cleared")
);

exports.ask = asyncHandler(async (req, res) =>
  ok(
    res,
    await assistantService.ask(
      req.user,
      req.body.question,
      { question: req.body.previousQuestion, answer: req.body.previousAnswer },
      // Everything asked this session, so a follow-up is never offered twice.
      req.body.asked || []
    )
  )
);
