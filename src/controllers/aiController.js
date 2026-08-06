const asyncHandler = require("../middlewares/asyncHandler");
const assistantService = require("../services/ai/assistantService");
const { ok } = require("../utils/apiResponse");

/**
 * The finance assistant.
 *
 * `req.user` comes from the verified token — the account is never read from the
 * body or a query parameter, so one person cannot ask questions about another's
 * money by editing a request.
 */

exports.getStatus = asyncHandler(async (req, res) =>
  ok(res, await assistantService.status(req.user._id))
);

/**
 * Starter questions for the empty state. Its own route rather than part of
 * `/status` because it builds the finance snapshot — worth doing when someone
 * opens the assistant, not on every page load.
 */
exports.getStarters = asyncHandler(async (req, res) =>
  ok(res, await assistantService.starters(req.user._id))
);

exports.ask = asyncHandler(async (req, res) =>
  ok(
    res,
    await assistantService.ask(
      req.user._id,
      req.body.question,
      { question: req.body.previousQuestion, answer: req.body.previousAnswer },
      // Everything asked this session, so a follow-up is never offered twice.
      req.body.asked || []
    )
  )
);
