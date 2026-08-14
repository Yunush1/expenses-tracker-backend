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
const complete = async ({ system, user, maxTokens = 500, temperature = 0.2 }) => {
  if (!isConfigured()) throw new Error("AI is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);

  try {
    const response = await fetch(`${config.ai.baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
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
      model: config.ai.model,
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

module.exports = { complete, isConfigured };
