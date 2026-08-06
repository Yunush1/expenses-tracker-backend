const aiProvider = require("./aiProvider");
const Member = require("../../models/member");
const Group = require("../../models/group");
const { GROUP_STATUS, SPLIT_TYPES, LIMITS } = require("../../constants");
const logger = require("../../utils/logger");

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

const looksLikeAdd = (text) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  // "How much did I add last week?" contains "add" and a shape that outranks it.
  if (QUESTION_SHAPE.test(trimmed)) return false;
  if (trimmed.endsWith("?")) return false;
  return ADD_INTENT.test(trimmed) && HAS_NUMBER.test(trimmed);
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

const SYSTEM_PROMPT = `You turn a short sentence into a structured expense for a bill-splitting app.
You do NOT create anything — a person reviews your output and confirms it.

Return ONLY a JSON object, no prose, no markdown fence, with these keys:
{
  "isExpense": boolean,
  "groupName": string | null,
  "description": string,
  "amount": string,
  "paidByName": string | null,
  "participantNames": string[] | null,
  "splitType": "EQUAL" | "EXACT",
  "confidence": "high" | "low",
  "missing": string[]
}

Rules:
- "amount" is the total of the bill as a plain decimal string, e.g. "1200" or "349.50". No currency symbol, no commas, no words. If the sentence says "twelve hundred", write "1200".
- Never invent an amount. If there is no number, set isExpense false.
- "description" is a short label for the purchase — 2 or 3 words, e.g. "Dinner", "Auto to airport". Do not put the amount in it.
- Use ONLY names from the member list given below. If someone is mentioned who is not in that list, leave them out and add "unknown person: <name>" to "missing".
- "paidByName" is who paid. If the sentence does not say, use null — the app defaults it to the person speaking.
- "participantNames" is who shares the cost. "everyone", "all of us", "the group" means null, which the app reads as every member. A cost split with nobody else is just the speaker.
- Use splitType "EQUAL" unless the sentence gives each person a different exact amount.
- Set "confidence" to "low" whenever you had to guess at the amount, the group, or who is involved.
- Set isExpense false for anything that is a question, a correction, or a request to delete or change something.`;

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
        `The person speaking is "${candidates[0].me?.name || "me"}".`,
        "Their groups and members:",
        roster,
        "",
        `Sentence: ${String(message).trim()}`,
      ].join("\n"),
      maxTokens: 300,
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

  return {
    needsGroup: false,
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
