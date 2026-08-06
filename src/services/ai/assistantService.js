const aiProvider = require("./aiProvider");
const financeContext = require("./financeContext");
const expenseDraft = require("./expenseDraft");
const { suggestFollowUps } = require("./suggestions");
const pointsService = require("../pointsService");
const { getRedis, isRedisReady } = require("../../config/redis");
const config = require("../../config/env");
const { BadRequestError, ServiceUnavailableError } = require("../../errors");
const { ERROR_CODES, POINT_EVENT_TYPES, POINTS } = require("../../constants");
const logger = require("../../utils/logger");

/**
 * "How much did I spend on food?" — answered from the asker's own data.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a presentation layer over figures `financeContext` already computed. It
 * is **not** a calculator, not an agent, and it writes nothing: there is no path
 * from a question to a created expense, a changed amount, or a recorded
 * settlement. The worst outcome of a bad answer is a bad sentence.
 *
 * That boundary is what makes it safe to ship early. Every number the model can
 * see was produced by the same services that render the UI, carrying the
 * assertions the app's credibility rests on (docs/10-AI-ASSISTANT.md §2).
 */

/** In-process fallback when Redis is unavailable, so a quota still exists. */
const localCounts = new Map();

const quotaKey = (userId) => `ai:quota:${userId}:${new Date().toISOString().slice(0, 10)}`;

/**
 * Two tiers, decided by how old the account is.
 *
 * Account age rather than "questions asked so far", because age is monotonic and
 * unforgeable from the client — a usage-based definition would let someone stay
 * "new" indefinitely by rationing their own questions, which is precisely
 * backwards.
 *
 * A caller that passes only an id gets the established tier. That is the safe
 * default: the failure mode is charging full price, not giving away a cheaper
 * rate to everyone.
 */
const NEW_USER_MS = () => config.ai.newUserDays * 24 * 60 * 60 * 1000;

const isNewAccount = (user) => {
  const createdAt = user?.createdAt;
  if (!createdAt) return false;
  return Date.now() - new Date(createdAt).getTime() < NEW_USER_MS();
};

/** The free daily allowance and the point price that follows the tier. */
const tierFor = (user) =>
  isNewAccount(user)
    ? { isNew: true, limit: config.ai.newUserQuota, cost: POINTS.AI_QUESTION_COST_NEW }
    : { isNew: false, limit: config.ai.dailyQuota, cost: POINTS.AI_QUESTION_COST };

/**
 * Count this question against the daily allowance.
 *
 * Incremented **before** the provider call, not after. A failed call still costs
 * latency and can still cost money, and counting only successes turns any
 * provider error into an unmetered retry loop.
 */
const consumeQuota = async (userId, limit) => {
  const key = quotaKey(userId);

  if (isRedisReady()) {
    try {
      const used = await getRedis().incr(key);
      // Expire slightly over a day; the key is date-stamped so it is replaced
      // rather than reused.
      if (used === 1) await getRedis().expire(key, 90000);
      return { used, limit, allowed: used <= limit };
    } catch {
      /* fall through to the in-process counter */
    }
  }

  const used = (localCounts.get(key) || 0) + 1;
  localCounts.set(key, used);
  // Keep the map from growing across days.
  if (localCounts.size > 10000) localCounts.clear();
  return { used, limit, allowed: used <= limit };
};

const peekQuota = async (userId, limit) => {
  const key = quotaKey(userId);

  if (isRedisReady()) {
    try {
      const used = Number((await getRedis().get(key)) || 0);
      return { used, limit, remaining: Math.max(0, limit - used) };
    } catch {
      /* fall through */
    }
  }

  const used = localCounts.get(key) || 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
};

/**
 * The instructions, and the reason each line is there.
 *
 * Most of this exists to stop the two failure modes that would matter: doing
 * arithmetic (it will eventually be wrong, stated fluently) and answering from
 * general knowledge when the data does not contain the answer (it will invent a
 * plausible number, which is worse than "I don't know").
 */
const SYSTEM_PROMPT = `You are a personal finance assistant inside an expense-splitting app.
You answer questions about ONE person's own money, using ONLY the JSON context provided.

Rules:
- Every figure you need has already been calculated and is in the context. Quote those figures exactly as written, including the currency symbol.
- Do NOT do arithmetic. Do not add, subtract, average or project numbers yourself. If a figure is not in the context, say it is not available rather than working it out.
- If the context does not answer the question, say so plainly and mention what you can see instead. Never guess or invent a transaction, person, amount or date.
- "Groups" are shared expenses split with other people. The "ledger" is this person's private record of what they spent alone and money they lent or borrowed. Keep the two distinct, and never add a group balance to a ledger figure — they are different kinds of money.
- A ledger spending entry with a "fromGroup" field is this person's own share of a group expense, already included in the ledger totals. The same bill also appears under that group as its full amount. Never add the two together, and when asked what they spent, use the ledger figure — it is their share, not what they fronted for everyone.
- Inside a group: "members" shows what each person paid and their net position. "settlementPlan" is the app's own calculation of the fewest payments that clear every debt — quote it as-is when asked how to settle up, and never propose a different set of payments. "paymentsRecorded" are transfers that already happened, and are already reflected in the balances, so do not subtract them again.
- When several groups are present, name the group you are talking about.
- Be brief: two or three sentences for a simple question. Use a short list only when comparing several items.
- Write plainly, like a careful friend. No markdown headers, no preamble, no financial advice, no suggestions to invest or borrow.
- Amounts are already formatted. Never reformat, round, or convert them.`;

const MAX_QUESTION_LENGTH = 500;

/**
 * Answer a question about the signed-in person's finances.
 *
 * @param user      the verified account — never taken from the request body
 * @param question  free text from the user
 */
const ask = async (user, question, previous = null, asked = []) => {
  const userId = user?._id || user;
  const tier = tierFor(user);

  if (!aiProvider.isConfigured()) {
    throw new ServiceUnavailableError(
      "The assistant is not configured on this server.",
      ERROR_CODES.FEATURE_UNAVAILABLE
    );
  }

  const trimmed = (question || "").trim();
  if (trimmed.length < 3) throw new BadRequestError("Ask a longer question.");
  if (trimmed.length > MAX_QUESTION_LENGTH) {
    throw new BadRequestError(`Keep questions under ${MAX_QUESTION_LENGTH} characters.`);
  }

  /**
   * The free allowance first, then points.
   *
   * Points are a top-up, never the only way in: an app that stops answering
   * until you have earned enough is worse than one with a modest fixed limit
   * (docs/11-REWARDS.md §4). So the daily quota is spent first, and only once it
   * is gone does a question cost points.
   */
  const quota = await consumeQuota(userId, tier.limit);
  let paidWithPoints = false;

  if (!quota.allowed) {
    paidWithPoints = await pointsService.spend(
      userId,
      POINT_EVENT_TYPES.SPEND_AI_QUESTION,
      tier.cost,
      { question: trimmed.slice(0, 80), cost: tier.cost, newAccount: tier.isNew }
    );

    if (!paidWithPoints) {
      const balance = await pointsService.getBalance(userId);
      throw new BadRequestError(
        `You've used all ${quota.limit} free questions for today. ` +
          `Another costs ${tier.cost} points and you have ${balance} — ` +
          "log an expense or settle up to earn more, or come back tomorrow.",
        ERROR_CODES.RATE_LIMITED
      );
    }
  }

  /**
   * "Add 1200 for dinner" is a different kind of message from "what did I spend".
   *
   * Checked before the context is built, because a draft needs the member roster
   * rather than the balance snapshot — and building both would pay for a page of
   * JSON the drafting prompt never reads.
   *
   * The result is a **proposal**, never a write. See expenseDraft.js for why the
   * confirmation step is not optional.
   */
  const draft = await expenseDraft.draftExpense(user, trimmed).catch(() => null);
  if (draft) {
    return {
      answer: draft.needsGroup
        ? "Which group is that for?"
        : `${draft.description} · ${draft.amount} in ${draft.groupName}. Check it and tap Add.`,
      usedContext: false,
      draft,
      quota: { used: quota.used, limit: quota.limit, paidWithPoints, pointCost: tier.cost },
    };
  }

  const context = await financeContext.build(userId);

  /**
   * Nothing to talk about — answered without a provider call. Asking a model to
   * say "you have no data" costs money to produce a sentence we already know.
   */
  if (!context?.hasAnything) {
    return {
      answer:
        "I can't see any expenses or ledger entries for your account yet. Add a few — or open a group on this device — and ask me again.",
      usedContext: false,
      quota: { used: quota.used, limit: quota.limit, paidWithPoints, pointCost: tier.cost },
    };
  }

  /**
   * The previous exchange, when the client sends one.
   *
   * Just one turn, not a growing history. The UI shows a transcript, so a
   * follow-up like "and last month?" has to resolve against what was just
   * asked — a chat window that visibly forgets the previous line is worse than
   * no transcript at all. Capping it at one exchange keeps the prompt bounded:
   * the context JSON is already the expensive part, and an unbounded history
   * would grow the cost of every question for the rest of the session.
   */
  const previousTurn =
    previous?.question && previous?.answer
      ? [
          "For context, the previous exchange in this conversation was:",
          `Q: ${String(previous.question).slice(0, 500)}`,
          `A: ${String(previous.answer).slice(0, 1000)}`,
          "Use it only to resolve references like \"that\" or \"and last month?\". The data below is still the only source of facts.",
          "",
        ]
      : [];

  const userMessage = [
    `Today is ${context.today}.`,
    `Here is ${context.person}'s financial data as JSON:`,
    JSON.stringify({ ledger: context.ledger, groups: context.groups }),
    "",
    ...previousTurn,
    `Question: ${trimmed}`,
  ].join("\n");

  try {
    const answer = await aiProvider.complete({
      system: SYSTEM_PROMPT,
      user: userMessage,
      maxTokens: 400,
    });

    return {
      answer,
      usedContext: true,
      quota: { used: quota.used, limit: quota.limit, paidWithPoints, pointCost: tier.cost },
      /**
       * Where to go next, derived from the same context the answer came from —
       * so every offer is answerable, and none of them repeats what was just
       * asked. Costs nothing: no second model call.
       */
      suggestions: suggestFollowUps(context, [...asked, trimmed]),
    };
  } catch (error) {
    // The question and the context must never reach a log line.
    logger.warn(`[ai] Assistant call failed for a user: ${error.message}`);

    /**
     * Two different messages, because they ask for two different things.
     *
     * A permanent failure (no credit, bad key, unknown model) is an operator
     * problem — and the operator is often the only user in early days. Saying
     * "try again in a moment" there is actively misleading: it sends someone to
     * retry a request that cannot succeed, and buries a billing issue behind
     * what reads as a hiccup.
     */
    throw new ServiceUnavailableError(
      error.permanent
        ? "The assistant is switched off — its AI provider isn't accepting requests (check the API key or account credit)."
        : "The assistant is busy right now. Please try again in a moment.",
      ERROR_CODES.FEATURE_UNAVAILABLE
    );
  }
};

/**
 * What the client needs to decide whether to render the button at all.
 *
 * Deliberately cheap — no context build. This is fetched on every page load to
 * decide whether the floating button appears, so it must stay two reads, not the
 * half-dozen queries a snapshot costs.
 */
const status = async (user) => {
  const tier = tierFor(user);
  return {
    enabled: aiProvider.isConfigured(),
    ...(await peekQuota(user?._id || user, tier.limit)),
    /**
     * The price this account actually pays, sent rather than assumed. The client
     * has no way to know which tier someone is in, and a drawer that offers "Use
     * 10 points" while the server charges 5 is a small lie that erodes the whole
     * points display.
     */
    pointCost: tier.cost,
    newAccount: tier.isNew,
  };
};

/**
 * Opening questions, for the empty state of the drawer.
 *
 * Separate from `status` precisely because it *does* build the context: it is
 * requested when someone opens the assistant, not on every page view. No model
 * call — these come from the data (see suggestions.js).
 */
const starters = async (userId) => {
  if (!aiProvider.isConfigured()) return { suggestions: [] };
  const context = await financeContext.build(userId);
  return { suggestions: suggestFollowUps(context, [], 4) };
};

module.exports = { ask, status, starters, SYSTEM_PROMPT };
