const logger = require("../utils/logger");
const { SUPPORTED_CURRENCIES } = require("../utils/money");

/**
 * Live exchange rates, fetched here rather than in the browser.
 *
 * ## Why the server and not the client
 *
 * Three reasons, in order of how much they matter:
 *
 * 1. **One call an hour for everybody**, instead of one per visitor. A free rate
 *    provider will rate-limit a popular page fetching it directly; a cached
 *    server-side copy will not notice the traffic at all.
 * 2. **No third party learns who the users are.** A browser-side fetch hands the
 *    provider every visitor's IP and referrer. This product's whole posture is
 *    that it does not leak its users (docs/02-HLD.md §3.4), and a rate lookup is
 *    a poor reason to start.
 * 3. **A provider outage becomes a stale rate, not a broken page**, because the
 *    last good response is kept and served with the timestamp that says how old
 *    it is.
 *
 * ## The rule that matters more than the source
 *
 * **A rate is used once, at the moment of conversion, and the result is frozen.**
 * A converted amount is stored as an integer in the target currency and never
 * recomputed. If a balance were re-derived from today's rate, every debt in a
 * group would move overnight without anybody touching it — which is precisely the
 * mismatch this feature is meant to prevent, arriving from the other direction.
 *
 * So this endpoint answers "what is the rate *now*", and the caller records what
 * it used. See docs/27-MULTI-CURRENCY.md.
 */

/**
 * exchangerate-api's open endpoint: no key, no account, 160+ currencies.
 *
 * Chosen over Frankfurter, which was the obvious candidate, for one reason that
 * decides it for this product: **Frankfurter publishes the ECB's reference rates,
 * and the ECB does not publish AED, SAR, QAR, LKR, NPR, BDT, PKR or VND.** An
 * Indian group splitting a Dubai trip is one of the most likely users of this
 * feature and Frankfurter cannot price their currency at all.
 *
 * What it is: daily data, updated once every 24 hours. That is the right
 * resolution for splitting a dinner and the wrong one for anything financial, and
 * the UI says so rather than implying a precision that is not there.
 *
 * A card's actual charged rate carries a spread and will differ by a percent or
 * two from any published mid-market rate. That is why the caller can always
 * override the number, and why the override is the more accurate answer whenever
 * somebody has their statement in front of them.
 */
const PROVIDER = "https://open.er-api.com/v6/latest";

/** One working day of data; an hour is a compromise between fresh and polite. */
const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

/**
 * The last good response, kept forever.
 *
 * Deliberately never cleared on failure: yesterday's rate is worth far more than
 * no rate, and it is served with `fetchedAt` so the caller can decide whether it
 * is too old to use. Process-local, so a restart re-fetches — which is fine, and
 * cheaper than a cache dependency for one small object.
 */
let cache = null;

const fetchFromProvider = async (base) => {
  const url = `${PROVIDER}/${encodeURIComponent(base)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });

  if (!response.ok) throw new Error(`${url} answered ${response.status}`);

  const body = await response.json();
  if (body?.result && body.result !== "success") throw new Error(`provider said "${body.result}"`);
  if (!body?.rates || typeof body.rates !== "object") throw new Error("no rates in the response");

  /**
   * Only the currencies this product can actually hold money in. The provider
   * returns several we do not support, and a rate for a currency no group can be
   * created in is a number nothing can use.
   *
   * The base is included at exactly 1 so callers never special-case it.
   */
  const rates = { [base]: 1 };
  for (const [code, rate] of Object.entries(body.rates)) {
    if (SUPPORTED_CURRENCIES.includes(code) && Number.isFinite(rate) && rate > 0) {
      rates[code] = rate;
    }
  }

  /**
   * `updatedAt` is the provider's own timestamp for the data, which is not the
   * same as when we fetched it — rates refresh daily, so a value fetched a minute
   * ago can still be twenty hours old. The UI shows the provider's, because that
   * is the number that says how stale the money is.
   */
  return {
    base,
    rates,
    updatedAt: body.time_last_update_utc ?? null,
    fetchedAt: new Date().toISOString(),
  };
};

/**
 * Rates for one base currency.
 *
 * Never throws. A caller that cannot get rates should still be able to render a
 * page and let somebody type a rate in by hand, so failure is expressed as
 * `stale: true` and whatever was last known — possibly nothing.
 */
const getRates = async (base = "INR") => {
  const code = String(base).toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(code)) {
    return { base: code, rates: {}, stale: true, fetchedAt: null, error: "unsupported currency" };
  }

  const fresh = cache && cache.base === code && Date.now() - cache.at < TTL_MS;
  if (fresh) return { ...cache.value, stale: false };

  try {
    const value = await fetchFromProvider(code);
    cache = { base: code, at: Date.now(), value };
    return { ...value, stale: false };
  } catch (error) {
    /**
     * Loud, because a rate feed that quietly stops updating is the worst version
     * of this feature: every conversion keeps working and every one of them is
     * wrong by a little more each day.
     */
    logger.warn(`[rates] ${PROVIDER} failed (${error.message}) — serving the last known rates`);

    if (cache && cache.base === code) return { ...cache.value, stale: true };
    return { base: code, rates: {}, stale: true, fetchedAt: null, error: error.message };
  }
};

module.exports = { getRates, PROVIDER, TTL_MS };
