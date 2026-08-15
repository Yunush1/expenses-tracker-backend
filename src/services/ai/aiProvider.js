const config = require("../../config/env");
const logger = require("../../utils/logger");
const aiUsage = require("./aiUsageService");

/**
 * The only place this app talks to a language model.
 *
 * One adapter, one wire format: OpenAI's `/v1/chat/completions`, which Hugging
 * Face's router, OpenAI, Groq, Together and most hosted providers all implement.
 * That makes the provider a config value rather than a code path, which matters
 * because model pricing and quality change faster than this product will.
 *
 * Everything about *what* to ask lives in assistantService; this file only knows
 * how to send it and how to fail politely.
 */

const isConfigured = () => Boolean(config.ai.apiKey);

/**
 * Send a chat completion. Returns the assistant's text, or throws a plain Error
 * whose message is safe to log — never the request body, which contains the
 * user's financial context.
 */
const complete = async ({
  system,
  user,
  maxTokens = 500,
  temperature = 0.2,
  /**
   * Data URLs to send alongside the text — a photographed receipt, today.
   *
   * The multi-part `content` array is the same OpenAI chat-completions shape the
   * text path uses, so this is one extra branch rather than a second adapter. A
   * request with images is still a chat completion; it simply costs several times
   * more and needs a model that can see (docs/10-AI-ASSISTANT.md §7).
   */
  images = [],
  /**
   * Which model to ask. Defaults to the text model, and is overridden for vision
   * because a 70B text model cannot read a photograph and fails in the least
   * useful way available — a confident, invented answer.
   */
  model = config.ai.model,
  /**
   * Which capability is spending — `ask`, `draft`, `receipt`, `suggestions`.
   *
   * Recorded on the meter so cost is answerable per feature rather than only per
   * model, which is what a per-use price has to be set from
   * (docs/22-MONETIZATION.md §1.4). Defaulting to `unknown` rather than being
   * required, because a caller that forgets should under-label a number, not fail
   * a user's request.
   */
  feature = "unknown",
} = {}) => {
  if (!isConfigured()) throw new Error("AI is not configured");

  const controller = new AbortController();
  /**
   * Vision calls get their own, longer timeout. A photograph is several thousand
   * tokens of input before the model writes a word, and aborting at the text
   * timeout would surface as "the assistant is busy" on a request that was working.
   */
  const timeoutMs = images.length > 0 ? config.ai.visionTimeoutMs : config.ai.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.ai.baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            /**
             * A plain string when there is nothing to look at, so every existing
             * caller sends exactly the bytes it sent before this parameter
             * existed — some providers behind the router are stricter about the
             * array form than the spec suggests.
             *
             * Text first, image second: the instruction is what the model should
             * be holding while it reads the picture.
             */
            content:
              images.length === 0
                ? user
                : [
                    { type: "text", text: user },
                    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
                  ],
          },
        ],
        max_tokens: maxTokens,
        /**
         * Low, not zero. This answers questions about someone's money: the same
         * question asked twice should give the same answer, and there is no
         * upside to creative variance in a number.
         */
        temperature,
      }),
    });

    if (!response.ok) {
      // Body may carry the provider's reason; status alone is rarely enough to
      // tell "out of credit" from "model not found".
      const detail = await response.text().catch(() => "");
      logger.warn(`[ai] Provider returned ${response.status}: ${detail.slice(0, 300)}`);

      const error = new Error(`AI provider error (${response.status})`);
      /**
       * Whether waiting could possibly help.
       *
       * 402 (out of credit), 401/403 (bad key) and 404 (no such model) are
       * configuration problems: they will fail identically in ten seconds and in
       * ten hours. Telling a user to "try again in a moment" there sends them to
       * retry something that cannot succeed, and hides a bill or a typo behind
       * what looks like a blip. 429 and 5xx genuinely are transient.
       */
      error.permanent = [401, 402, 403, 404].includes(response.status);
      error.status = response.status;
      throw error;
    }

    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content?.trim();

    if (!text) throw new Error("AI returned an empty response");

    /**
     * Meter the call, here, because this is the only place it can be done once.
     *
     * Three services call `complete`, and metering at each of them is how one of
     * them silently stops counting the moment a fourth is added. This function is
     * already documented as "the only place this app talks to a language model" —
     * so it is also the only place that knows a call happened at all.
     *
     * Not awaited and never allowed to throw, the same rule as the transcript write
     * in assistantService.record: the caller has their answer, and failing to file a
     * meter reading is not a reason to turn a successful reply into an error. The
     * return type stays a plain string so no caller changes.
     */
    aiUsage.record({
      // The model actually used, not the configured default — vision costs
      // multiples of text, and a meter that filed both under one name would hide
      // exactly the number this feature has to be judged on. `aiUsage` keys its
      // buckets on `{ day, model }`, so this separates them with no other change.
      model,
      feature,
      // `usage` is part of the OpenAI response shape every provider behind this
      // router implements. Absent on a provider that does not, in which case the
      // call is still counted and the tokens read zero rather than breaking.
      promptTokens: body?.usage?.prompt_tokens,
      completionTokens: body?.usage?.completion_tokens,
    });

    return text;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("AI timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Whether this deployment can read a photograph.
 *
 * Separate from `isConfigured` because it fails separately: a provider key that
 * works perfectly for text says nothing about whether the configured vision model
 * exists on it. Callers use this to hide a camera button rather than offer one
 * that always errors.
 */
const isVisionConfigured = () => isConfigured() && Boolean(config.ai.visionModel);

module.exports = { complete, isConfigured, isVisionConfigured };
