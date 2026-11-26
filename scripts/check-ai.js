/**
 * Is the AI provider actually usable?
 *
 *   npm run ai:check
 *
 * Sends one trivial completion to every configured provider — the primary and
 * each fallback — and reports what came back in plain language. Exists because
 * every provider reports the same few problems differently — Hugging Face says
 * 402 "credits depleted" one hour and 401 "api key invalid" the next for the
 * same exhausted account — and reading that through the app's error handling
 * adds a layer between you and the answer.
 */
const config = require("../src/config/env");

const MASK = (key) => (key ? `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)` : "(not set)");

const PROVIDER_NAMES = {
  gemini: "Google Gemini",
  groq: "Groq",
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI-compatible",
};

const ADVICE = {
  400: [
    "The request was rejected.",
    "  • Gemini answers an invalid key with 400 \"API key not valid\" — check GEMINI_API_KEY.",
    "  • Otherwise the model name or a parameter is wrong for this provider.",
  ],
  401: [
    "The provider rejected the key itself.",
    "  • Check it was copied whole, with no trailing quote or space.",
    "  • On Hugging Face, a depleted free allowance can present as 401 as well as 402.",
  ],
  402: [
    "The key is valid but the account has no credit left.",
    "  • Add credits, or rely on a free-tier provider (GEMINI_API_KEY / GROQ_API_KEY).",
  ],
  403: ["The key is valid but not permitted to use this model. Try another model id."],
  404: [
    "The endpoint or model name was not found.",
    "  • The model id must be spelled exactly as that provider names it.",
  ],
  429: [
    "Rate limited or free-tier quota used up. The configuration is fine.",
    "  • With a fallback configured, the app moves on to the next provider automatically.",
  ],
  503: [
    "The provider is overloaded right now. The configuration is fine — retry in a minute.",
    "  • With a fallback configured, the app moves on to the next provider automatically.",
  ],
};

const ALTERNATIVES = `
Free-tier providers — set a key and restart, no code change:

  Google Gemini (key from aistudio.google.com/apikey)
    GEMINI_API_KEY=<your key>
    GEMINI_MODEL=gemini-3.8-flash          (default)
    GEMINI_VISION_MODEL=gemini-3.8-flash   (optional: receipt scanning)

  Groq (key from console.groq.com/keys) — used as the fallback when set
    GROQ_API_KEY=<your key>
    GROQ_MODEL=openai/gpt-oss-120b         (default)

  Order: AI_PROVIDER picks the first; AI_FALLBACK_PROVIDERS (default "groq")
  lists the rest. Model ids change; take the exact string from the provider's docs.`;

/**
 * Config mistakes that are visible without spending a request.
 *
 * Worth catching up front because the resulting HTTP error names the wrong
 * culprit: an OpenAI key sent to DeepSeek returns "your api key is invalid",
 * which sends you to regenerate a key that was never the problem.
 */
const KEY_PREFIXES = [
  { prefix: "hf_", vendor: "Hugging Face", host: "huggingface" },
  { prefix: "gsk_", vendor: "Groq", host: "groq" },
  { prefix: "AIza", vendor: "Google", host: "googleapis" },
];

const preflight = (provider) => {
  const problems = [];
  const { completionsUrl = "", apiKey, model } = provider;
  if (provider.kind === "anthropic") return problems;

  // AI_BASE_URL gets /v1/chat/completions appended, so one ending in /v1
  // produces /v1/v1/... — which some providers answer with a confusing 401.
  if (/\/v\d+\/v1\/chat\/completions$/.test(completionsUrl)) {
    problems.push(
      `The base URL ends in a version segment. It should be the host only — the code adds "/v1/chat/completions".\n` +
        `      requests go to: ${completionsUrl}`
    );
  }

  const known = KEY_PREFIXES.find((entry) => apiKey.startsWith(entry.prefix));
  if (known && !completionsUrl.includes(known.host)) {
    problems.push(
      `The key looks like a ${known.vendor} key ("${known.prefix}…") but the endpoint is elsewhere.\n` +
        `      Keys are not portable between providers — each one needs its own.`
    );
  }

  // A slash in the model name is Hugging Face's org/model convention; most other
  // providers use a bare id.
  // Only for the generic provider: Groq's own ids (openai/gpt-oss-120b) have slashes too.
  if (provider.name === "openai" && model.includes("/") && !completionsUrl.includes("huggingface")) {
    problems.push(
      `Model "${model}" is in Hugging Face's org/model form, but the endpoint is not Hugging Face.\n` +
        `      Other providers use their own bare model ids.`
    );
  }

  return problems;
};

const checkAnthropic = async (provider) => {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: provider.apiKey });
  const startedAt = Date.now();
  try {
    const reply = await client.messages.create({
      model: provider.model,
      max_tokens: 1024,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
    });
    const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    console.log(`  RESULT: working — Claude (${reply.model}) replied in ${Date.now() - startedAt}ms with "${text}"`);
    return true;
  } catch (error) {
    console.log(`  RESULT: Anthropic returned ${error.status ?? "an error"} in ${Date.now() - startedAt}ms`);
    console.log(`    ${String(error.message).slice(0, 300)}`);
    if (error.status === 401) console.log("    • The key is wrong — create one at platform.claude.com (API keys).");
    if (error.status === 400 && /credit/i.test(error.message)) {
      console.log("    • The API account has no credit — add some under Billing at platform.claude.com.");
      console.log("      A claude.ai Pro/Max subscription does not include API credit.");
    }
    if (error.status === 404) console.log(`    • ANTHROPIC_MODEL "${provider.model}" is not a model this key can use.`);
    return false;
  }
};

const checkOpenAICompatible = async (provider) => {
  const thinks = Boolean(provider.reasoningEffort) && provider.reasoningEffort !== "none";
  const started = Date.now();
  let response;

  try {
    response = await fetch(provider.completionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        // Thinking tokens count against max_tokens; 5 would all be spent on thought.
        max_tokens: thinks ? 2048 : 5,
        ...(provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
      }),
    });
  } catch (error) {
    console.log(`  RESULT: could not reach the provider — ${error.message}`);
    console.log("          Check the URL and this machine's network access.");
    return false;
  }

  const ms = Date.now() - started;
  const body = await response.text();

  if (response.ok) {
    let reply = "";
    try {
      reply = JSON.parse(body)?.choices?.[0]?.message?.content?.trim() || "";
    } catch {
      /* shown raw below */
    }

    /**
     * 200 is not success. A model the gateway accepts but does not actually
     * serve returns an empty `content`, and treating that as working is how a
     * green check here turns into a 503 in the app — the least useful possible
     * outcome for a diagnostic.
     */
    if (!reply) {
      console.log(`  RESULT: the provider answered ${response.status} but sent no text.`);
      console.log(`    ${body.slice(0, 300)}`);
      console.log("    The credentials are fine — this is the model.");
      console.log(`      • "${provider.model}" may not be served on your account, or it returns`);
      console.log("        its output in a non-standard field this app does not read.");
      return false;
    }

    console.log(`  RESULT: working — replied in ${ms}ms with "${reply}"`);
    return true;
  }

  console.log(`  RESULT: provider returned ${response.status} in ${ms}ms`);
  console.log(`    ${body.slice(0, 300)}`);
  for (const line of ADVICE[response.status] || ["Unrecognised error — see the body above."]) {
    console.log(`    ${line}`);
  }
  if (response.status === 404) await listModels(provider);
  return false;
};

/**
 * On "model not found", ask the provider which models this key can use.
 *
 * Model ids retire faster than defaults in code get updated, and the provider's
 * own `/models` list is the only source that is right for *this* account.
 */
const listModels = async (provider) => {
  const modelsUrl = provider.completionsUrl.replace(/\/chat\/completions$/, "/models");
  try {
    const response = await fetch(modelsUrl, { headers: { Authorization: `Bearer ${provider.apiKey}` } });
    if (!response.ok) {
      console.log(`    (could not list models: ${response.status})`);
      return;
    }
    const ids = ((await response.json())?.data || [])
      .map((entry) => String(entry.id || "").replace(/^models\//, ""))
      .filter(Boolean)
      .sort();
    const envName = `${provider.name.toUpperCase()}_MODEL`;
    console.log(`    Models this key can use — set one as ${envName} in .env:`);
    for (const id of ids) console.log(`      ${id}`);
  } catch (error) {
    console.log(`    (could not list models: ${error.message})`);
  }
};

(async () => {
  console.log("AI provider check\n");
  console.log(`  quota : ${config.ai.dailyQuota} questions per account per day\n`);

  const chain = config.ai.chain;
  if (chain.length === 0) {
    console.log("RESULT: no key configured, so the assistant is switched off.");
    console.log("        The app runs normally; the Ask panel simply does not render.");
    console.log(ALTERNATIVES);
    process.exitCode = 0;
    return;
  }

  const results = [];
  for (const [index, provider] of chain.entries()) {
    console.log(`${index === 0 ? "Primary" : `Fallback ${index}`}: ${PROVIDER_NAMES[provider.name] || provider.name}`);
    if (provider.completionsUrl) console.log(`  endpoint : ${provider.completionsUrl}`);
    console.log(`  model    : ${provider.model}`);
    console.log(`  vision   : ${provider.visionModel || "(off — receipt scanning skips this provider)"}`);
    if (provider.reasoningEffort) console.log(`  thinking : ${provider.reasoningEffort}`);
    console.log(`  api key  : ${MASK(provider.apiKey)}`);

    const problems = preflight(provider);
    if (problems.length > 0) {
      console.log("  CONFIG PROBLEMS FOUND BEFORE SENDING ANYTHING:");
      problems.forEach((problem, i) => console.log(`    ${i + 1}. ${problem}`));
    }

    results.push(
      provider.kind === "anthropic" ? await checkAnthropic(provider) : await checkOpenAICompatible(provider)
    );
    console.log("");
  }

  const working = results.filter(Boolean).length;
  if (working === chain.length) {
    console.log(`SUMMARY: all ${chain.length} provider(s) working. The assistant is ready.`);
    process.exitCode = 0;
  } else if (working > 0) {
    console.log(`SUMMARY: ${working} of ${chain.length} provider(s) working — the assistant runs, with less fallback cover.`);
    process.exitCode = 1;
  } else {
    console.log("SUMMARY: no provider is working, so assistant requests will fail.");
    console.log(ALTERNATIVES);
    process.exitCode = 1;
  }
})();
