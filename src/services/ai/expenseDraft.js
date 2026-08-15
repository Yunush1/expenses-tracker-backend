const aiProvider = require("./aiProvider");
const Member = require("../../models/member");
const Group = require("../../models/group");
const { GROUP_STATUS, SPLIT_TYPES, LIMITS } = require("../../constants");
const logger = require("../../utils/logger");
const { SYSTEM_PROMPT } = require("./systemPromt");
const { resolveExpenseDate } = require("../../utils/parseExpenseDate");

/**
 * "Add 1200 for dinner, split with everyone" → a **draft** the user confirms.
 *
 * ## The boundary, and why it is where it is
 *
 * Nothing in this file writes an expense. It returns a proposal; the client shows
 * the numbers; the person taps Add; and the ordinary `POST /expenses` endpoint —
 * with its validation, its share arithmetic, its `Σ shares = amount` assertion and
 * its permission checks — does the actual work.
 *
 * That is not caution for its own sake. A language model transcribing "twelve
 * hundred" as 12000 is a normal, expected failure, and an expense is money owed
 * between friends. The model is allowed to be wrong about what someone said; it
 * is not allowed to be wrong about what is in the ledger. A confirmation step
 * costs one tap and converts every extraction error into a visible, correctable
 * one — which is the entire difference between a helpful shortcut and a liability
 * (docs/10-AI-ASSISTANT.md §7).
 *
 * The model also never computes shares. It says *who* is involved and *how* to
 * split; the split maths belongs to the calculator that already has the remainder
 * rules right (docs/05-ALGORITHMS.md §2).
 */

/**
 * Does this message want to *add* something, rather than ask about it?
 *
 * Deliberately conservative, and checked before the model is called at all. A
 * false positive here answers a question with a form, which is far more annoying
 * than a false negative — that just answers normally, which is the whole rest of
 * the product working.
 */
const ADD_INTENT = /\b(add|log|record|note|put|create)\b/i;
const QUESTION_SHAPE = /^\s*(what|how much|who|when|why|which|where|do i|did i|am i|is there|show|tell)\b/i;
const HAS_NUMBER = /\d/;
/**
 * A dictated amount, which does not always arrive as digits.
 *
 * Speech recognition returns "add four hundred for petrol" as words often enough
 * that a digit-only gate silently swallows dictated expenses: the message routes
 * to FINANCE, comes back answered as a question, and the microphone looks broken.
 * The model itself handles the words perfectly well — it returns `amount: "400"`,
 * which `AMOUNT` below then validates — so this gate was the only thing in the way.
 *
 * A magnitude word is required rather than any number word, and that is the whole
 * trade-off. "Add four hundred for petrol" gets through; "add one more member"
 * still does not, because widening far enough to catch a bare "add fifty for chai"
 * would let every "note down three things" spend a drafting call. Small amounts
 * are also the ones recognisers reliably return as digits, so the case being given
 * up is the rare half of a rare problem.
 */
const SPOKEN_MAGNITUDE = /\b(hundred|thousand|lakh|lakhs|crore|crores)\b/i;

const looksLikeAdd = (text) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  // "How much did I add last week?" contains "add" and a shape that outranks it.
  if (QUESTION_SHAPE.test(trimmed)) return false;
  if (trimmed.endsWith("?")) return false;
  return (
    ADD_INTENT.test(trimmed) && (HAS_NUMBER.test(trimmed) || SPOKEN_MAGNITUDE.test(trimmed))
  );
};

/** The groups this person can actually write to, with their member lists. */
const writableGroups = async (user) => {
  const deviceIds = (user.deviceIds || []).filter(Boolean);
  if (deviceIds.length === 0) return [];

  const mine = await Member.find({ deviceIds: { $in: deviceIds }, isActive: true })
    .select("_id groupId name")
    .lean();
  if (mine.length === 0) return [];

  const groups = await Group.find({
    _id: { $in: [...new Set(mine.map((m) => String(m.groupId)))] },
    status: GROUP_STATUS.ACTIVE,
  })
    .select("_id name currency inviteCode")
    .sort({ lastActivityAt: -1 })
    .limit(8)
    .lean();

  const meByGroup = new Map(mine.map((m) => [String(m.groupId), m]));

  return Promise.all(
    groups.map(async (group) => ({
      group,
      me: meByGroup.get(String(group._id)),
      members: await Member.find({ groupId: group._id, isActive: true })
        .select("_id name")
        .lean(),
    }))
  );
};


/** Whitespace and fences the model sometimes wraps JSON in, despite being asked not to. */
const parseJson = (raw) => {
  const text = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

/** Case- and spacing-insensitive, because people type "riya" for "Riya ". */
const findMember = (members, name) => {
  if (!name) return null;
  const wanted = String(name).trim().toLowerCase();
  return (
    members.find((m) => m.name.trim().toLowerCase() === wanted) ||
    members.find((m) => m.name.trim().toLowerCase().startsWith(wanted)) ||
    null
  );
};

const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Build a draft from a sentence, or return null when it is not an add request.
 *
 * Returns `{ needsGroup: true, groups }` when the person is in several groups and
 * did not say which — asking is right there. Guessing "the most recent one" would
 * put a bill in front of the wrong people, and the confirmation card is exactly
 * where an ambiguity like that should surface.
 */
const draftExpense = async (user, message) => {
  if (!looksLikeAdd(message)) return null;
  if (!aiProvider.isConfigured()) return null;

  const candidates = await writableGroups(user);
  if (candidates.length === 0) return null;

  const roster = candidates
    .map(
      ({ group, members }) =>
        `- ${group.name}: ${members.map((m) => m.name).join(", ")}`
    )
    .join("\n");

  let parsed;
  try {
    const raw = await aiProvider.complete({
      system: SYSTEM_PROMPT,
      user: [
        `Today is ${new Date().toISOString().slice(0, 10)}.`,
        `The person speaking is "${candidates[0].me?.name || "me"}".`,
        "Their groups and members:",
        roster,
        "",
        `Sentence: ${String(message).trim()}`,
      ].join("\n"),
      maxTokens: 300,
      feature: "draft",
    });
    parsed = parseJson(raw);
  } catch (err) {
    logger.warn(`[ai] Expense draft failed: ${err.message}`);
    return null;
  }

  if (!parsed?.isExpense) return null;

  const amount = String(parsed.amount ?? "").trim();
  // No amount, no draft. Better to answer as a question than to show a form with
  // an empty or invented figure in it.
  if (!AMOUNT.test(amount) || Number(amount) <= 0) return null;
  if (Number(amount) > LIMITS.MAX_AMOUNT_MAJOR) return null;

  const chosen =
    candidates.find(
      (c) => c.group.name.trim().toLowerCase() === String(parsed.groupName || "").trim().toLowerCase()
    ) || (candidates.length === 1 ? candidates[0] : null);

  if (!chosen) {
    return {
      needsGroup: true,
      amount,
      description: String(parsed.description || "").slice(0, LIMITS.EXPENSE_DESC_MAX) || "Expense",
      groups: candidates.map(({ group }) => ({
        id: String(group._id),
        name: group.name,
        inviteCode: group.inviteCode,
        currency: group.currency,
      })),
    };
  }

  const { group, me, members } = chosen;

  const paidBy = findMember(members, parsed.paidByName) || me;

  /**
   * `null` participants means everyone — the same default the form uses, and the
   * reading of "split with everyone" that people expect. An explicit list is
   * mapped by name and silently loses anyone unrecognised, which is why the model
   * is told to report those in `missing` instead.
   */
  const named = Array.isArray(parsed.participantNames) ? parsed.participantNames : null;
  const participants = named
    ? named.map((name) => findMember(members, name)).filter(Boolean)
    : members;

  // A split needs somebody in it; fall back to everyone rather than to nobody.
  const finalParticipants = participants.length > 0 ? participants : members;

  /**
   * When the money was spent — re-derived from the user's own words.
   *
   * The model's answer is the fallback, not the source: "last Friday" is date
   * arithmetic, and a wrong month here silently moves the expense out of the
   * monthly total someone will later check. See utils/parseExpenseDate.js.
   */
  const when = resolveExpenseDate({
    text: message,
    modelDate: parsed.expenseDate,
  });

  return {
    needsGroup: false,
    expenseDate: when.date,
    /**
     * True when the message named a period but not a day — "last month's fuel".
     * The draft still carries today's date so it is usable; the card says the
     * date is a guess rather than picking a day the user never chose.
     */
    dateUncertain: when.needsConfirmation || Boolean(parsed.assistant?.needsConfirmation),
    groupId: String(group._id),
    groupName: group.name,
    inviteCode: group.inviteCode,
    currency: group.currency,
    description: String(parsed.description || "").slice(0, LIMITS.EXPENSE_DESC_MAX) || "Expense",
    amount,
    paidBy: { id: String(paidBy._id), name: paidBy.name },
    participants: finalParticipants.map((m) => ({ id: String(m._id), name: m.name })),
    splitType: parsed.splitType === SPLIT_TYPES.EXACT ? SPLIT_TYPES.EXACT : SPLIT_TYPES.EQUAL,
    /**
     * Surfaced to the user, not swallowed. "I couldn't find Sam in this group" is
     * the kind of thing that has to be visible *before* the split is agreed, not
     * discovered afterwards by whoever ends up short.
     */
    confidence: parsed.confidence === "low" ? "low" : "high",
    missing: Array.isArray(parsed.missing) ? parsed.missing.slice(0, 4) : [],
  };
};

module.exports = { draftExpense, looksLikeAdd, parseJson, findMember, SYSTEM_PROMPT };
