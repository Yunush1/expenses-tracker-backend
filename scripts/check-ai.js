/**
 * Is the AI provider actually usable?
 *
 *   npm run ai:check
 *
 * Sends one trivial completion with the configured credentials and reports what
 * came back in plain language. Exists because every provider reports the same
 * few problems differently — Hugging Face says 402 "credits depleted" one hour
 * and 401 "api key invalid" the next for the same exhausted account — and
 * reading that through the app's error handling adds a layer between you and the
 * answer.
 */
require("../src/config/env");

const config = require("../src/config/env");

const MASK = (key) => (key ? `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)` : "(not set)");

const ADVICE = {
  401: [
    "The provider rejected the key itself.",
    "  • Check it was copied whole, with no trailing quote or space.",
    "  • On Hugging Face, a depleted free allowance can present as 401 as well as 402.",
    "  • Confirm the key has Inference permission, not just repo read.",
  ],
  402: [
    "The key is valid but the account has no credit left.",
    "  • Hugging Face free tier: monthly included credits are exhausted.",
    "  • Add pre-paid credits, subscribe, or point AI_BASE_URL at another provider.",
  ],
  403: ["The key is valid but not permitted to use this model. Try a smaller or open model."],
  404: [
    "The endpoint or model name was not found.",
    `  • AI_BASE_URL should be the host *without* /v1 — currently: ${config.ai.baseUrl}`,
    `  • AI_MODEL must be spelled exactly as that provider names it — currently: ${config.ai.model}`,
  ],
  429: ["Rate limited. The configuration is fine; wait and retry."],
};

const ALTERNATIVES = `
Any OpenAI-compatible endpoint works. Set three values and restart:

  Groq (free tier, fast)
    AI_BASE_URL=https://api.groq.com/openai
    AI_MODEL=<a current Groq model id>

  Google Gemini (free tier; you already have a Google account)
    AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
    AI_MODEL=<a current Gemini model id>

  OpenAI
    AI_BASE_URL=https://api.openai.com
    AI_MODEL=<a current OpenAI model id>

Model ids change; take the exact string from the provider's own docs.
The assistant needs no code change for any of these.`;

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

const preflight = () => {
  const problems = [];
  const { baseUrl, apiKey, model } = config.ai;

  // The code appends /v1/chat/completions, so a base URL ending in /v1 produces
  // /v1/v1/... — which some providers answer with a confusing 401 rather than 404.
  if (/\/v\d+$/.test(baseUrl)) {
    problems.push(
      `AI_BASE_URL ends in a version segment. It should be the host only — the code adds "/v1/chat/completions".\n` +
        `      currently: ${baseUrl}\n` +
        `      requests go to: ${baseUrl}/v1/chat/completions`
    );
  }

  const known = KEY_PREFIXES.find((entry) => apiKey.startsWith(entry.prefix));
  if (known && !baseUrl.includes(known.host)) {
    problems.push(
      `The key looks like a ${known.vendor} key ("${known.prefix}…") but AI_BASE_URL points somewhere else.\n` +
        `      Keys are not portable between providers — each one needs its own.`
    );
  }

  // A slash in the model name is Hugging Face's org/model convention; most other
  // providers use a bare id.
  if (model.includes("/") && !baseUrl.includes("huggingface")) {
    problems.push(
      `AI_MODEL "${model}" is in Hugging Face's org/model form, but AI_BASE_URL is not Hugging Face.\n` +
        `      Other providers use their own bare model ids.`
    );
  }

  return problems;
};

(async () => {
  console.log("AI provider check\n");
  console.log(`  base URL : ${config.ai.baseUrl}`);
  console.log(`  model    : ${config.ai.model}`);
  console.log(`  api key  : ${MASK(config.ai.apiKey)}`);
  console.log(`  quota    : ${config.ai.dailyQuota} questions per account per day\n`);

  const problems = preflight();
  if (problems.length > 0) {
    console.log("CONFIG PROBLEMS FOUND BEFORE SENDING ANYTHING:\n");
    problems.forEach((problem, index) => console.log(`  ${index + 1}. ${problem}\n`));
    console.log("  Fixing these first will save chasing an error that names the wrong cause.\n");
  }

  if (!config.ai.apiKey) {
    console.log("RESULT: no key configured, so the assistant is switched off.");
    console.log("        The app runs normally; the Ask panel simply does not render.");
    console.log(ALTERNATIVES);
    process.exitCode = 0;
    return;
  }

  const started = Date.now();
  let response;

  try {
    response = await fetch(`${config.ai.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        max_tokens: 5,
      }),
    });
  } catch (error) {
    console.log(`RESULT: could not reach the provider — ${error.message}`);
    console.log("        Check the URL and this machine's network access.");
    process.exitCode = 1;
    return;
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
     * outcome for a diagnostic. Some routers do this for reasoning models whose
     * text lands in a different field, others for models no enabled provider
     * hosts.
     */
    if (!reply) {
      console.log(`RESULT: the provider answered ${response.status} but sent no text.\n`);
      console.log(`  ${body.slice(0, 300)}\n`);
      console.log("  The credentials are fine — this is the model.");
      console.log(`    • "${config.ai.model}" may not be served by any provider enabled on your account.`);
      console.log("    • Or it returns its output in a non-standard field this app does not read.");
      console.log("    • Pick a widely-hosted instruct model and re-run this check.");
      console.log(ALTERNATIVES);
      process.exitCode = 1;
      return;
    }

    console.log(`RESULT: working — replied in ${ms}ms with "${reply}"`);
    console.log("        The assistant will answer questions on the ledger and group pages.");
    process.exitCode = 0;
    return;
  }

  console.log(`RESULT: provider returned ${response.status} in ${ms}ms\n`);
  console.log(`  ${body.slice(0, 300)}\n`);
  for (const line of ADVICE[response.status] || ["Unrecognised error — see the body above."]) {
    console.log(`  ${line}`);
  }
  console.log(ALTERNATIVES);
  process.exitCode = 1;
})();
