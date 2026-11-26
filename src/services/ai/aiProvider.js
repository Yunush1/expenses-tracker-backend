const config = require("../../config/env");
const logger = require("../../utils/logger");
const aiUsage = require("./aiUsageService");
const Anthropic = require("@anthropic-ai/sdk");

/**
 * The only place this app talks to a language model.
 *
 * One adapter, one wire format: OpenAI's `/v1/chat/completions`, which Hugging
 * Face's router, OpenAI, Groq, Together and most hosted providers all implement.
 * That makes the provider a config value rather than a code path, which matters
 * because model pricing and quality change faster than this product will.
 *
 * Google Gemini (GEMINI_API_KEY) goes through this same path via Google's
 * OpenAI-compatible endpoint; Claude has its own adapter below.
 *
 * Everything about *what* to ask lives in assistantService; this file only knows
 * how to send it and how to fail politely.
 */

const isConfigured = () => config.ai.chain.length > 0;

/**
 * Claude, through Anthropic's SDK and Messages API — the `anthropic` provider.
 *
 * Same contract as the OpenAI path: returns the reply text, meters the call,
 * and throws an Error carrying `status` and `permanent` so assistantService
 * can tell a billing/config problem from a blip.
 */
let anthropicClient = null;
const getAnthropic = (apiKey) => {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
};

// Models that support the server-side refusal fallback: on a policy decline the
// API re-runs the request on another model inside the same call.
const SUPPORTS_FALLBACK = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-[12])$/;

/** `data:image/jpeg;base64,…` → an Anthropic base64 image block. */
const toImageBlock = (dataUrl) => {
  const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error("AI image must be a base64 data URL");
  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
};

const completeWithClaude = async (provider, { system, user, maxTokens, images, model, feature }) => {
  const controller = new AbortController();
  const timeoutMs = images.length > 0 ? config.ai.visionTimeoutMs : config.ai.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const params = {
    model,
    /**
     * Claude thinks before it writes, and thinking counts against max_tokens.
     * The caller's budget is meant for the answer, so add headroom on top —
     * billing is on tokens actually used, not on the ceiling.
     */
    max_tokens: maxTokens + 2048,
    output_config: { effort: config.ai.anthropicEffort },
    ...(system ? { system } : {}),
    messages: [
      {
        role: "user",
        // Images first, then the instruction — Claude reads best that way.
        content: images.length === 0 ? user : [...images.map(toImageBlock), { type: "text", text: user }],
      },
    ],
    // No `temperature`: current Claude models reject sampling parameters.
  };
  if (SUPPORTS_FALLBACK.test(model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  try {
    const response = await getAnthropic(provider.apiKey).beta.messages.create(params, {
      signal: controller.signal,
      // The SDK retries 429/5xx itself; one retry keeps the wall clock near the timeout.
      maxRetries: 1,
    });

    if (response.stop_reason === "refusal") {
      logger.warn(`[ai] Claude declined a ${feature} request (${response.stop_details?.category || "no category"})`);
      throw new Error("AI declined the request");
    }

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new Error("AI returned an empty response");

    aiUsage.record({
      model: response.model || model,
      feature,
      promptTokens:
        (response.usage?.input_tokens || 0) +
        (response.usage?.cache_read_input_tokens || 0) +
        (response.usage?.cache_creation_input_tokens || 0),
      completionTokens: response.usage?.output_tokens,
    });

    return text;
  } catch (error) {
    if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
      throw new Error("AI timed out");
    }
    if (error instanceof Anthropic.APIError && error.status) {
      // Log Anthropic's reason (e.g. "credit balance is too low"), never the request.
      logger.warn(`[ai] Anthropic returned ${error.status}: ${String(error.message).slice(0, 300)}`);
      const wrapped = new Error(`AI provider error (${error.status})`);
      // 400 covers "credit balance too low" and bad parameters — neither heals on retry.
      wrapped.permanent = [400, 401, 402, 403, 404].includes(error.status);
      wrapped.status = error.status;
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One provider that speaks OpenAI's `/chat/completions` — Gemini, Groq, Hugging
 * Face's router, or any other compatible endpoint.
 */
const completeOpenAICompatible = async (
  provider,
  { system, user, maxTokens, temperature, images, model, feature }
) => {
  const controller = new AbortController();
  /**
   * Vision calls get their own, longer timeout. A photograph is several thousand
   * tokens of input before the model writes a word, and aborting at the text
   * timeout would surface as "the assistant is busy" on a request that was working.
   */
  const timeoutMs = images.length > 0 ? config.ai.visionTimeoutMs : config.ai.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    /**
     * Reasoning models (Gemini 3, Groq's gpt-oss) spend thinking tokens out of
     * `max_tokens`, so when thinking is on, add headroom so the caller's budget
     * still covers the answer.
     */
    const isGemini = provider.name === "gemini";
    const thinks = Boolean(provider.reasoningEffort) && provider.reasoningEffort !== "none";

    const response = await fetch(provider.completionsUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
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
        max_tokens: thinks ? maxTokens + 2048 : maxTokens,
        ...(provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
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
      logger.warn(`[ai] ${provider.name} returned ${response.status}: ${detail.slice(0, 300)}`);

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
      // Gemini answers a bad key with 400 "API key not valid", not 401.
      error.permanent = [401, 402, 403, 404, ...(isGemini ? [400] : [])].includes(response.status);
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
const isVisionConfigured = () => config.ai.chain.some((provider) => provider.visionModel);

/**
 * Send a chat completion. Returns the assistant's text, or throws a plain Error
 * whose message is safe to log — never the request body, which contains the
 * user's financial context.
 *
 * Tries each provider in `config.ai.chain` in turn: the primary first, then the
 * fallbacks (AI_FALLBACK_PROVIDERS), so Gemini hitting its free-tier quota hands
 * the question to Groq instead of telling the user to wait.
 */
const complete = async ({
  system,
  user,
  maxTokens = 500,
  temperature = 0.2,
  /**
   * Data URLs to send alongside the text — a photographed receipt, today.
   *
   * A request with images costs several times more and needs a model that can
   * see (docs/10-AI-ASSISTANT.md §7), so only providers with a vision model are
   * tried, each with its own — a text model handed a photograph does not error,
   * it invents a plausible receipt.
   */
  images = [],
  /**
   * Overrides the primary provider's model. Fallbacks always use their own,
   * because a model name from one provider means nothing to another.
   */
  model,
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
  const vision = images.length > 0;
  const candidates = config.ai.chain.filter((provider) => !vision || provider.visionModel);
  if (candidates.length === 0) throw new Error("AI is not configured");

  const errors = [];
  for (const [index, provider] of candidates.entries()) {
    const ownModel = vision ? provider.visionModel : provider.model;
    const request = {
      system,
      user,
      maxTokens,
      temperature,
      images,
      model: index === 0 && model ? model : ownModel,
      feature,
    };

    try {
      return provider.kind === "anthropic"
        ? await completeWithClaude(provider, request)
        : await completeOpenAICompatible(provider, request);
    } catch (error) {
      // A content refusal would be refused again elsewhere — not a provider fault.
      if (error.message === "AI declined the request") throw error;
      errors.push(error);
      const next = candidates[index + 1];
      if (next) {
        logger.warn(`[ai] ${provider.name} failed (${error.message}) — falling back to ${next.name}`);
      }
    }
  }

  /**
   * Every provider failed. Surface the last error, but only call it permanent if
   * all of them were: one rate-limited provider means waiting can still help.
   */
  const last = errors[errors.length - 1];
  last.permanent = errors.every((error) => error.permanent);
  throw last;
};

module.exports = { complete, isConfigured, isVisionConfigured };
