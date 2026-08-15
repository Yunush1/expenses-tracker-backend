const aiProvider = require("./aiProvider");
const config = require("../../config/env");
const { parseJson } = require("./expenseDraft");
const { toMinor } = require("../../utils/money");
const { inferCategory } = require("../../utils/inferCategory");
const { LIMITS } = require("../../constants");
const logger = require("../../utils/logger");

/**
 * A photographed receipt → line items somebody confirms
 * (docs/10-AI-ASSISTANT.md §4.2, docs/22-MONETIZATION.md §14 step 7).
 *
 * ## Nothing here writes an expense
 *
 * The same boundary `expenseDraft` draws, and for a stronger reason. A model
 * misreading crumpled thermal paper is not an edge case, it is Tuesday — glare,
 * folds, mixed scripts, a total that includes tax the line items do not. So this
 * returns a **proposal**: the client shows the lines in `MultiExpenseForm`, the
 * person fixes what is wrong, and the ordinary batch endpoint — with its
 * validation, its share arithmetic and its permission checks — does the writing.
 *
 * The model is allowed to be wrong about what a photograph says. It is not allowed
 * to be wrong about what is in the ledger.
 *
 * ## The photograph is never stored
 *
 * It is read, turned into text, and dropped. `expense.attachments[]` stays
 * reserved and unused.
 *
 * That is a deliberate choice rather than an unfinished one. A receipt is a
 * photograph of a place someone was, at a time, with a card (docs/10 §8) — keeping
 * it would mean a retention policy, a deletion path, a storage bill and a much
 * larger thing to lose. Everything the group actually needs from the photo is the
 * numbers, and those go into the expense where they can be read, edited and
 * deleted like anything else.
 *
 * ## Why the failure modes are enumerated rather than hidden
 *
 * `unresolved[]` names what the model was unsure of, so the UI can highlight those
 * fields instead of presenting every line with equal confidence. A scan that
 * quietly rounds a 7 into a 1 and looks identical to a correct one is worse than
 * no scan at all.
 */

/**
 * What the model is asked to produce.
 *
 * Three instructions do most of the work here. **Transcribe, do not calculate** —
 * a model that adds up a column will confidently produce a total that is not on
 * the paper, and the app has a calculator that gets remainders right. **Say when
 * you cannot read something** rather than guessing, because a guess is
 * indistinguishable from a reading. And **never invent a line**, which is the
 * failure that turns a helpful shortcut into a fabricated debt between friends.
 */
const SYSTEM_PROMPT = `You read photographs of receipts and bills and return JSON. Nothing else.

Return exactly this shape:
{
  "isReceipt": true,
  "merchant": "string or null",
  "date": "YYYY-MM-DD or null",
  "currencyCode": "3-letter code or null",
  "total": "number as a string, or null",
  "items": [{ "description": "string", "amount": "number as a string" }],
  "unresolved": ["short phrases naming what you could not read"]
}

Rules:
- Transcribe only. Never add up a column, never compute a total, never apply tax.
  If the printed total is unreadable, return null for it.
- Never invent an item. If a line is illegible, omit it and say so in "unresolved".
- Amounts are plain numbers: "1250.50", not "Rs. 1,250.50" and not "1250,50".
- "description" is what the line says, shortened to a few words. Keep the
  merchant's own wording; do not translate or tidy it.
- Skip subtotals, tax lines, discounts, tips, service charges and the grand total —
  those are not items. Put the grand total in "total".
- If the photo is not a receipt or bill, return {"isReceipt": false}.
- Output JSON only. No prose, no code fences.`;

/** Data URLs only, and only image types a vision model actually accepts. */
const DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * How many bytes a base64 string decodes to, without decoding it.
 *
 * Measuring the encoded length would over-report by a third and reject images the
 * limit was meant to allow; decoding to find out allocates the very buffer the
 * limit exists to prevent.
 */
const decodedBytes = (base64) => {
  const clean = base64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
};

/**
 * Reject anything that is not a plausibly-sized image, before it reaches a
 * provider that charges by the token.
 *
 * Returns a message rather than throwing, so the caller decides the status code —
 * and, importantly, so this can run *before* the group's scan allowance is
 * claimed. Charging somebody a scan for uploading a PDF would be indefensible.
 */
const validateImage = (dataUrl) => {
  if (typeof dataUrl !== "string" || !DATA_URL.test(dataUrl)) {
    return "That doesn't look like a photo. Use a JPEG, PNG or WebP image.";
  }

  const [, , base64] = DATA_URL.exec(dataUrl);
  const bytes = decodedBytes(base64);

  if (bytes < 1024) return "That image is too small to read.";

  if (bytes > config.ai.maxImageBytes) {
    const mb = (config.ai.maxImageBytes / (1024 * 1024)).toFixed(1);
    return `That photo is too large — keep it under ${mb} MB.`;
  }

  return null;
};

const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * A model's number, in whatever shape it arrived, or null.
 *
 * ## Why a comma can end the whole thing
 *
 * "1,250.50" is twelve hundred and fifty rupees. "1250,50" is twelve hundred and
 * fifty in half of Europe — and stripping commas indiscriminately turns the second
 * into **125050**, a hundred times the real figure, in a line somebody is one tap
 * from adding to a shared ledger. A hundredfold error that looks like a plausible
 * amount is the worst thing this file could produce.
 *
 * So a comma is accepted only in the one shape that cannot mean anything else — a
 * thousands separator, three digits at a time — and anything else with a comma in
 * it is dropped and reported in `unresolved`, where a human reads the number off
 * the photo instead. The prompt already forbids both spellings; this is what
 * happens when the model does it anyway, which it will.
 */
const cleanAmount = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  /**
   * A negative is a discount, a refund or a returned item, and the prompt already
   * says to skip those. Dropping the sign along with the currency symbol would
   * turn "−40 loyalty discount" into a ₹40 charge shared between flatmates —
   * billing people for money the shop took *off* the bill.
   *
   * `(40.00)` is the same claim in accounting notation, and receipts print it.
   */
  if (/^[-−–]/.test(text) || /^\(.*\)$/.test(text)) return null;

  const stripped = text
    // Currency symbols, letters, spaces — "Rs. 1,250.50" and "₹1250" both arrive.
    .replace(/[^\d.,]/g, "")
    // The dot left behind by "Rs." is punctuation, not a decimal point.
    .replace(/^[.,]+/, "")
    .replace(/[.,]+$/, "");

  let normalised;

  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(stripped)) {
    // Unambiguously grouped: 1,250 · 1,250.50 · 12,34,567 is not matched, and a
    // lakh-grouped number failing here costs a dropped line, not a wrong one.
    normalised = stripped.replace(/,/g, "");
  } else if (stripped.includes(",")) {
    return null;
  } else {
    normalised = stripped;
  }

  if (!AMOUNT.test(normalised)) return null;

  const value = Number(normalised);
  if (!(value > 0) || value > LIMITS.MAX_AMOUNT_MAJOR) return null;

  return normalised;
};

/** A date the model read, only if it is real and not in the future. */
const cleanDate = (raw) => {
  const text = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;

  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;

  // A receipt dated next year is a misread year, not a prophecy. One day's grace
  // for timezones, matching the expense validator.
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;

  return text;
};

/**
 * Read one photograph.
 *
 * Throws on anything that should not be charged for — an unconfigured deployment,
 * a provider failure — so the caller can hand the group's scan allowance back.
 * Returns `{ isReceipt: false }` for a photograph that simply was not a receipt,
 * which **is** charged: the model was called and the bill is real, and a free
 * retry on "not a receipt" is a free vision call for anyone who wants one.
 */
const scanReceipt = async ({ dataUrl, currency = "INR" }) => {
  if (!aiProvider.isVisionConfigured()) {
    throw new Error("Receipt scanning is not configured on this server");
  }

  let parsed;
  try {
    const raw = await aiProvider.complete({
      system: SYSTEM_PROMPT,
      user: [
        `Today is ${new Date().toISOString().slice(0, 10)}.`,
        `This group records expenses in ${currency}.`,
        "Read this receipt.",
      ].join("\n"),
      images: [dataUrl],
      model: config.ai.visionModel,
      /**
       * Room for a long till roll. A supermarket receipt with thirty lines is the
       * case this exists for, and truncating one mid-JSON produces a parse failure
       * after the expensive part of the call has already been paid for.
       */
      maxTokens: 1500,
      /** Transcription, not composition. As deterministic as the provider allows. */
      temperature: 0,
      /**
       * The expensive one, and therefore the one whose per-call cost decides
       * whether it can be sold per use at all (docs/22-MONETIZATION.md §14 step 7).
       */
      feature: "receipt",
    });

    parsed = parseJson(raw);
  } catch (error) {
    logger.warn(`[ai] Receipt scan failed: ${error.message}`);
    throw error;
  }

  if (!parsed || parsed.isReceipt === false) {
    return { isReceipt: false, items: [], unresolved: [] };
  }

  /**
   * Items are filtered, not repaired. A line whose amount cannot be read as a
   * number is dropped and named in `unresolved` — putting a zero or a guess in
   * front of somebody, in a list they are about to confirm, is how a wrong number
   * gets into a shared ledger with a tap.
   */
  const dropped = [];
  const items = [];

  for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
    if (items.length >= LIMITS.MAX_BATCH_ITEMS) {
      dropped.push(`more than ${LIMITS.MAX_BATCH_ITEMS} lines — the rest were left out`);
      break;
    }

    const amount = cleanAmount(item?.amount);
    const description = String(item?.description ?? "").trim().slice(0, LIMITS.EXPENSE_DESC_MAX);

    if (!amount || !description) {
      if (description) dropped.push(`couldn't read the amount for "${description}"`);
      continue;
    }

    items.push({
      description,
      amount,
      amountMinor: toMinor(amount, currency),
      // The same inference every hand-typed expense gets, so a scanned line and a
      // typed one land in the same category (docs/16-TODO.md §2.3).
      category: inferCategory(description) || null,
    });
  }

  const total = cleanAmount(parsed.total);
  const itemsMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);
  const totalMinor = total ? toMinor(total, currency) : null;

  return {
    isReceipt: true,
    merchant: String(parsed.merchant ?? "").trim().slice(0, LIMITS.EXPENSE_DESC_MAX) || null,
    date: cleanDate(parsed.date),
    currencyCode: /^[A-Z]{3}$/.test(String(parsed.currencyCode ?? "").trim().toUpperCase())
      ? String(parsed.currencyCode).trim().toUpperCase()
      : null,
    total,
    totalMinor,
    items,
    itemsMinor,
    /**
     * Whether the lines add up to the printed total.
     *
     * Reported, never corrected. They legitimately differ — tax, service, a
     * discount, a line the camera missed — and the honest thing is to say so and
     * let the person decide, rather than silently inserting a "difference" line
     * nobody was charged for.
     *
     * Null when the total could not be read, because "we don't know" and "they
     * match" are different answers.
     */
    balances: totalMinor === null ? null : totalMinor === itemsMinor,
    differenceMinor: totalMinor === null ? null : totalMinor - itemsMinor,
    unresolved: [
      ...(Array.isArray(parsed.unresolved) ? parsed.unresolved : [])
        .map((entry) => String(entry).trim().slice(0, 120))
        .filter(Boolean),
      ...dropped,
    ].slice(0, 6),
  };
};

module.exports = { scanReceipt, validateImage, SYSTEM_PROMPT, cleanAmount, cleanDate, decodedBytes };
