const aiProvider = require("./aiProvider");
const AiMessage = require("../../models/aiMessage");
const { formatMinor } = require("../../utils/money");
const financeContext = require("./financeContext");
const expenseDraft = require("./expenseDraft");
const { suggestFollowUps, buildStarters } = require("./suggestions");
const sheetDraft = require("./sheetDraft");
const intent = require("./intent");
const pointsService = require("../pointsService");
const { getRedis, isRedisReady } = require("../../config/redis");
const config = require("../../config/env");
const { BadRequestError, ServiceUnavailableError } = require("../../errors");
const { ERROR_CODES, LIMITS, POINT_EVENT_TYPES, POINTS } = require("../../constants");
const logger = require("../../utils/logger");
const { SYSTEM_PROMPT } = require('./system_promt')

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

const MAX_QUESTION_LENGTH = 500;

/**
 * A zero, as `formatMinor` writes it — compared as a string because that is what
 * the context holds. Every figure arrives pre-formatted, so parsing one back to
 * a number just to test it against zero would reintroduce exactly the client-side
 * money arithmetic this module exists to avoid.
 */
const ZERO = formatMinor(0);

/**
 * How much of the transcript the drawer restores when it reopens.
 *
 * From constants rather than a literal here: the request validator has to accept a
 * question list this long back from the client, and when the two were independent
 * numbers they disagreed — see LIMITS.AI_HISTORY_PAGE for what that cost.
 */
const HISTORY_PAGE = LIMITS.AI_HISTORY_PAGE;

/**
 * Keep the exchange, without making the answer wait on it.
 *
 * Not awaited and never allowed to throw: the person has their answer, and
 * failing to file a transcript is not a reason to turn a successful reply into
 * an error. Same reasoning as the push dispatch in `activityService.record`.
 */
const record = (userId, question, answer, usedContext) => {
  AiMessage.create({ userId, question, answer: String(answer).slice(0, 4000), usedContext }).catch(
    (err) => logger.warn(`[ai] Could not save the exchange: ${err.message}`)
  );
};

/**
 * The transcript, oldest last so the client can render it top to bottom.
 *
 * Fetched newest-first and reversed, because "the most recent 30" is the page
 * worth keeping and a skip-based query over a growing collection is not.
 */
const history = async (userId, limit = HISTORY_PAGE) => {
  const rows = await AiMessage.find({ userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, HISTORY_PAGE))
    .lean();

  return {
    turns: rows.reverse().map((row) => ({
      id: String(row._id),
      question: row.question,
      answer: row.answer,
      usedContext: row.usedContext !== false,
      at: row.createdAt,
    })),
  };
};

/** Forget the conversation. The ledger it was about is untouched. */
const clearHistory = async (userId) => {
  const { deletedCount } = await AiMessage.deleteMany({ userId });
  return { cleared: deletedCount || 0 };
};

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
   * What kind of message this is, decided once.
   *
   * "Add 1200 for dinner", "make me an order slip" and "what did I spend" are
   * three different jobs, and this is where they part company.
   *
   * `intent.classify` owns the rules and the precedence between them; this only
   * dispatches. Two drafters can claim a message — "create a 10-question quiz"
   * reads as an add request on "create" and "10" — and resolving that here, in an
   * order that happened to work, is how the quiz ended up drafted as an expense.
   */
  const type = intent.classify(trimmed);

  /**
   * A table to build. Nothing is written: the reply carries a blueprint and the
   * client asks before creating anything (sheetDraft.js).
   */
  const asTable = async () => {
    const blueprint = await sheetDraft.draftSheet(trimmed).catch(() => null);
    if (!blueprint) return null;

    const answer = blueprint.note
      ? `Here's a ${blueprint.title.toLowerCase()} — ${blueprint.note}`
      : `Here's a ${blueprint.title.toLowerCase()}. Have a look, and create it if it fits.`;

    record(userId, trimmed, answer, false);
    return { answer, usedContext: false, draft: blueprint };
  };

  /**
   * An expense to add — also a proposal, never a write. See expenseDraft.js for
   * why the confirmation step is not optional.
   */
  const asExpense = async () => {
    const draft = await expenseDraft.draftExpense(user, trimmed).catch(() => null);
    if (!draft) return null;

    const answer = draft.needsGroup
      ? "Which group is that for?"
      : `${draft.description} · ${draft.amount} in ${draft.groupName}. Check it and tap Add.`;

    record(userId, trimmed, answer, false);
    return { answer, usedContext: false, draft };
  };

  /**
   * Both run *before* the finance context is built, because neither reads it —
   * a template request and an expense draft want the column shapes and the
   * member roster respectively, and assembling the balance snapshot for them
   * would be a page of JSON produced and thrown away.
   *
   * A drafter that declines falls through to the ordinary answer rather than to
   * the other one. The classification was already the decision; trying the rest
   * in turn is what made the precedence unreadable.
   */
  const drafter = { [intent.AI_INTENT.SHEET]: asTable, [intent.AI_INTENT.EXPENSE]: asExpense }[type];

  if (drafter) {
    const drafted = await drafter();
    if (drafted) {
      return {
        ...drafted,
        quota: { used: quota.used, limit: quota.limit, paidWithPoints, pointCost: tier.cost },
      };
    }
  }

  const context = await financeContext.build(userId);

  /**
   * Nothing to talk about — answered without a provider call. Asking a model to
   * say "you have no data" costs money to produce a sentence we already know.
   */
  if (!context?.hasAnything) {
    const answer =
      "I can't see any expenses or ledger entries for your account yet. Add a few — or open a group on this device — and ask me again.";

    record(userId, trimmed, answer, false);

    return {
      answer,
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

  /**
   * `people` first, labelled, and written as sentences rather than JSON.
   *
   * Two separate problems were making per-person questions fail. The totals did
   * not exist, so the model was being asked for a figure it was also forbidden
   * to calculate — that is fixed in financeContext. And the context was one
   * dense JSON blob, in which an 8B model demonstrably loses rows: asked about
   * Pankaj it reported no such person, then listed Pankaj among the names it
   * knew when asked about someone else.
   *
   * One line per person fixes the second. It costs a few more tokens than
   * minified JSON and buys reliability on the most common question there is.
   * The other sections stay JSON — they are read as structure, not scanned for a
   * name.
   */
  /**
   * One line per person, carrying only the facts that are not zero.
   *
   * The first version listed all six figures every time, so Pankaj — who simply
   * owes ₹10,000 — read as six clauses of nearly identical wording padded with
   * four ₹0.00s. The model reliably mispaired them: asked what Pankaj owed, it
   * answered "you still owe Pankaj ₹10,000.00", taking the phrase from one
   * clause and the number from another. Reversing a debt is the worst mistake
   * this feature can make.
   *
   * Dropping the zeros removes the material to confuse. A person with one open
   * balance now has one clause, and there is no second number on the line to
   * attach the wrong words to. Zero is still an answer — it is just carried by
   * the "nothing outstanding" case rather than repeated six times.
   */
  const describePerson = (p) => {
    const facts = [];

    if (p.stillOwedToYou !== ZERO) facts.push(`${p.name} still owes you ${p.stillOwedToYou}`);
    if (p.youStillOweThem !== ZERO) facts.push(`you still owe ${p.name} ${p.youStillOweThem}`);
    if (p.youHavePaidThemInTotal !== ZERO) {
      facts.push(`you have paid ${p.name} ${p.youHavePaidThemInTotal} so far`);
    }
    if (p.theyHavePaidYouInTotal !== ZERO) {
      facts.push(`${p.name} has paid you ${p.theyHavePaidYouInTotal} so far`);
    }

    const where = p.inGroups?.length ? ` (in ${p.inGroups.join(", ")})` : "";
    return facts.length
      ? `- ${p.name}${where}: ${facts.join("; ")}.`
      : `- ${p.name}${where}: nothing outstanding either way, and nothing paid between you.`;
  };

  const peopleLines = (context.people ?? []).length
    ? context.people.map(describePerson).join("\n")
    : "(no named people on record)";

  const userMessage = [
    `Today is ${context.today}.`,
    `Here is ${context.person}'s financial data.`,
    "",
    "PEOPLE — every person on record, with totals already calculated across both the ledger and group settlements. This list is complete: if a name is not here, there is no record of them.",
    peopleLines,
    "",
    "LEDGER — their private record of what they spent alone and money lent or borrowed:",
    JSON.stringify(context.ledger),
    "",
    "GROUPS — shared expenses split with other people:",
    JSON.stringify(context.groups),
    "",
    ...previousTurn,
    `Question: ${trimmed}`,
  ].join("\n");

  try {
    const answer = await aiProvider.complete({
      system: SYSTEM_PROMPT,
      user: userMessage,
      maxTokens: 400,
      // The headline feature, and the one a quota is counted against — so it is
      // the number a Pro tier's AI allowance would be priced from.
      feature: "ask",
    });

    record(userId, trimmed, answer, true);

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

  /**
   * Questions about their data first, then things to build.
   *
   * The order is the point. Someone with expenses is most likely here to ask
   * about them, so those lead — but `suggestFollowUps` returns **nothing** when
   * there is no data, and a brand new account would otherwise open an assistant
   * with no prompts and no clue what it does. The build prompts need no data, so
   * they fill that space and are the better first impression: on day one the
   * honest offer is "I can make you something", not "ask me about the expenses
   * you have not entered yet".
   */
  const questions = suggestFollowUps(context, [], 2);
  return { suggestions: [...questions, ...buildStarters(4 - questions.length)] };
};

module.exports = { ask, status, starters, history, clearHistory, SYSTEM_PROMPT };
