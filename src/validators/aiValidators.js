const { z } = require("zod");

const { LIMITS } = require("../constants");

/**
 * Request shapes for the assistant.
 *
 * Extracted from aiRoutes.js, which was the only router carrying its schema
 * inline — and that is not merely a tidiness point. The `asked` bound below has to
 * agree with a constant in the service layer, and a schema buried in a route file
 * is one nothing can import to check that.
 */

/**
 * `asked` is bounded by what the history endpoint can hand back.
 *
 * ## The bug this fixes
 *
 * The cap used to be a literal 20 while `GET /ai/history` returns up to
 * `HISTORY_PAGE` (30) exchanges. The client rebuilds its transcript from that
 * response and echoes every question it contains, so anyone whose saved
 * conversation passed twenty exchanges got
 *
 *     400 VALIDATION_ERROR: Array must contain at most 20 element(s)
 *
 * on **every** question from then on. Not one failed request — the assistant was
 * permanently unusable for exactly the people using it most, and the only escape
 * was clearing the conversation, which the error did not say.
 *
 * ## Why it is shared rather than a bigger literal
 *
 * Writing 30 here would fix today and break again the moment the history page size
 * moved. The two are not independent numbers that happen to be close: one is the
 * size of the state the server hands the client, the other is the size of the state
 * the server will accept back. Reading both from `LIMITS.AI_HISTORY_PAGE` makes that
 * relationship true by construction, and tests/aiContract.test.js pins it so a
 * future edit cannot quietly reintroduce the same failure.
 *
 * These strings are only ever used to filter a suggestion list — they are never
 * sent to the model (services/ai/suggestions.js), so the bound is about request
 * size, not cost.
 */
const askSchema = z.object({
  question: z.string().trim().min(3).max(500),
  /**
   * The immediately preceding exchange, so a follow-up can resolve "that".
   * Optional and bounded — the client sends at most one turn, and the
   * service never treats it as a source of facts.
   */
  previousQuestion: z.string().trim().max(500).optional(),
  previousAnswer: z.string().trim().max(2000).optional(),
  /**
   * Questions already asked this session, so a follow-up suggestion never
   * offers back something answered a moment ago.
   */
  asked: z.array(z.string().trim().max(500)).max(LIMITS.AI_HISTORY_PAGE).optional(),
});

module.exports = { askSchema };
