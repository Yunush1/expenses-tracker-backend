const mongoose = require("mongoose");

/**
 * One exchange with the assistant: what was asked, and what it answered.
 *
 * ## Why this is stored at all
 *
 * Without it the transcript lives in React state and dies when the drawer
 * closes. Someone who asks "how much do I owe Krishan?", closes the panel and
 * comes back has no record that they ever asked — and the follow-up feature
 * ("and last month?") has nothing to resolve against on a fresh page load.
 *
 * ## What it is not
 *
 * Not a source of facts. Answers are replayed to the *user* so they can read
 * back the conversation; they are never fed to the model as data. Every figure
 * is re-derived from `financeContext` on each question, because a stored answer
 * goes stale the moment an expense is added — and a confidently stale number is
 * the failure this whole feature is built to avoid (docs/10-AI-ASSISTANT.md §2).
 *
 * ## Retention
 *
 * These rows contain someone's financial questions in their own words, which is
 * more revealing than the ledger itself. They expire on their own rather than
 * accumulating forever — a transcript nobody will read again is only a liability.
 */
const RETENTION_DAYS = 90;

const aiMessageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    question: { type: String, required: true, trim: true, maxlength: 500 },
    answer: { type: String, required: true, trim: true, maxlength: 4000 },
    /**
     * False when the reply was produced without the finance snapshot — a draft
     * proposal, or the "nothing on record yet" case. Worth keeping so a replayed
     * transcript can be read correctly rather than looking like a real answer.
     */
    usedContext: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/** The transcript, newest first. */
aiMessageSchema.index({ userId: 1, createdAt: -1 });

/**
 * Mongo deletes these itself. A cron sweep would be another moving part that can
 * silently stop, and the one thing worse than no retention policy is one
 * everybody believes is running.
 */
aiMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model("AiMessage", aiMessageSchema);
module.exports.RETENTION_DAYS = RETENTION_DAYS;
