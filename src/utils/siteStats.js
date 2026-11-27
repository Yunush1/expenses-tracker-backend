/**
 * Pure helpers for the first-party visit counter (docs: services/siteStatsService.js).
 *
 * Kept free of Mongo and Express so the rules that decide what gets stored —
 * which is the privacy boundary of the feature — are unit tested on their own
 * (tests/siteStats.test.js).
 */

/**
 * Paths whose next segment is a credential: an invite code, a share code, a
 * sheet's share code. Anyone holding the URL is in the group, so the code must
 * never reach a database that is read for something else. Same list the
 * frontend's analytics.js redacts for Google Analytics, plus `/s/`.
 */
const CAPABILITY_PREFIXES = ["/g/", "/join/", "/sheet/", "/s/"];

/** Letters, digits and the punctuation real routes use. Anything else is noise. */
const SAFE_PATH = /^\/[a-z0-9\-_/.:]*$/;

const MAX_PATH_LENGTH = 100;
const MAX_SEGMENTS = 4;

/**
 * The path a view is filed under, or `null` to drop it.
 *
 * Query string and hash go entirely (a `?description=` can hold anything a
 * visitor typed). Capability paths collapse to `/g/:code`. A trailing slash is
 * folded so `/blog` and `/blog/` count once. Anything that does not look like
 * one of this site's routes is filed as `/other` rather than stored verbatim,
 * because a public endpoint that stores arbitrary keys is a free database for
 * whoever finds it.
 */
const normalizePath = (raw) => {
  if (typeof raw !== "string") return null;

  let path = raw.split("?")[0].split("#")[0].trim().toLowerCase();
  if (!path.startsWith("/")) return null;

  for (const prefix of CAPABILITY_PREFIXES) {
    if (path.startsWith(prefix)) return `${prefix}:code`;
  }

  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";

  if (
    path.length > MAX_PATH_LENGTH ||
    !SAFE_PATH.test(path) ||
    path.includes("..") ||
    path.split("/").length - 1 > MAX_SEGMENTS
  ) {
    return "/other";
  }

  return path;
};

const SEARCH = [/(^|\.)google\./, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/, /(^|\.)yahoo\./, /(^|\.)yandex\./, /(^|\.)ecosia\.org$/, /(^|\.)baidu\.com$/];
const SOCIAL = [
  /(^|\.)facebook\.com$/,
  /(^|\.)fb\.me$/,
  /(^|\.)instagram\.com$/,
  /^t\.co$/,
  /(^|\.)twitter\.com$/,
  /(^|\.)x\.com$/,
  /(^|\.)linkedin\.com$/,
  /^lnkd\.in$/,
  /(^|\.)reddit\.com$/,
  /(^|\.)whatsapp\.com$/,
  /^wa\.me$/,
  /(^|\.)youtube\.com$/,
  /(^|\.)pinterest\./,
  /(^|\.)quora\.com$/,
  /(^|\.)threads\.net$/,
  /(^|\.)telegram\.org$/,
  /^t\.me$/,
];
const AI = [/(^|\.)chatgpt\.com$/, /(^|\.)openai\.com$/, /(^|\.)perplexity\.ai$/, /(^|\.)claude\.ai$/, /(^|\.)gemini\.google\.com$/, /(^|\.)copilot\.microsoft\.com$/];

/**
 * Where a visit came from, as one of a fixed set of buckets.
 *
 * Takes the referring *hostname* only (the frontend never sends the full URL).
 * Buckets, not hostnames, are stored for the same reason paths are cleaned: the
 * set of keys stays small and nothing a visitor's browser reports is written
 * back verbatim. Returns `null` for navigation inside the site, which is not a
 * source at all.
 */
const classifySource = (refHost, siteHosts = []) => {
  const host = typeof refHost === "string" ? refHost.trim().toLowerCase().replace(/^www\./, "") : "";
  if (!host) return "direct";

  const own = siteHosts.map((h) => String(h).toLowerCase().replace(/^www\./, ""));
  if (own.includes(host)) return null;

  // Checked before search: gemini.google.com would otherwise read as Google.
  if (AI.some((re) => re.test(host))) return "ai";
  if (SEARCH.some((re) => re.test(host))) return "search";
  if (SOCIAL.some((re) => re.test(host))) return "social";
  if (host === "android-app" || host.startsWith("com.")) return "app";
  return "other";
};

/**
 * Crawlers, link previewers and lab tools (Lighthouse/PageSpeed run as headless
 * Chrome). None of them is a person, and PageSpeed alone would otherwise add a
 * "visitor" every time someone checks the score.
 */
const BOT_UA = /bot|crawl|spider|slurp|preview|lighthouse|headless|pagespeed|facebookexternalhit|embedly|whatsapp|curl|wget|python-requests|node-fetch|axios/i;

const isBot = (userAgent) => !userAgent || BOT_UA.test(String(userAgent));

/**
 * The `days` calendar days ending on `today`, oldest first, as `YYYY-MM-DD`.
 * Plain string arithmetic on dates at UTC noon, so no zone or DST can make a
 * day appear twice or vanish.
 */
const dayRange = (today, days) => {
  const end = Date.parse(`${today}T12:00:00Z`);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
};

module.exports = {
  CAPABILITY_PREFIXES,
  normalizePath,
  classifySource,
  isBot,
  dayRange,
};
