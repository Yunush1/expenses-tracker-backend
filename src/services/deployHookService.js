const config = require("../config/env");
const logger = require("../utils/logger");

/**
 * Asks the frontend host to rebuild, because a published post is not crawlable
 * until it does.
 *
 * ## Why publishing has to reach outside this process at all
 *
 * The site is a client-rendered SPA whose public pages are pre-rendered to static
 * HTML at build time (docs/15-SEO.md §3). That is the whole reason the marketing
 * pages are indexable, and it means a post sitting in this database is invisible
 * to every crawler that does not run JavaScript — which is Bing, DuckDuckGo, and
 * every social and chat unfurler — until a build has run and written
 * `dist/blog/<slug>/index.html`.
 *
 * So "publish" is two facts, not one: the row flips to PUBLISHED *and* the static
 * site is regenerated. This module is the second half. Netlify, Cloudflare Pages
 * and Vercel all expose the same primitive for it — a secret URL that starts a
 * build when POSTed to.
 *
 * ## Why a failure here is logged and not raised
 *
 * The database write has already committed by the time this runs, and it is the
 * authoritative one: the post *is* published, the API serves it, the React route
 * renders it, and the next build for any reason at all will pick it up. Throwing
 * would show the author an error for an operation that succeeded, and — worse —
 * invite a retry that publishes nothing twice.
 *
 * What the caller gets instead is the outcome, returned rather than thrown, so
 * the response can tell the author plainly that the post is live but the rebuild
 * did not start. Silence would be the bad option: an author who is not told has
 * no reason to look, and the post stays uncrawlable for as long as nobody
 * deploys.
 *
 * ## Why there is no debounce
 *
 * Publishing three posts in a minute fires three builds, and the host will queue
 * or cancel the redundant ones itself — both Netlify and Vercel cancel a build
 * superseded by a newer one on the same branch. A debounce here would mean
 * holding a timer in a process that can be restarted or scaled to two instances,
 * where the failure mode is a build that never fires and a post that is never
 * indexed. The wasted build minutes are cheaper than that.
 */

/** Beyond this, assume the hook is not going to answer and stop waiting. */
const TIMEOUT_MS = 10_000;

const isConfigured = () => Boolean(config.blog.deployHookUrl);

/**
 * Fire the hook. Never throws.
 *
 * Returns `{ triggered, reason }` — `triggered: false` with a human-readable
 * reason is a normal outcome on a deployment that has no hook configured, which
 * includes every developer machine.
 */
const trigger = async (why = "content change") => {
  if (!isConfigured()) {
    return {
      triggered: false,
      reason:
        "No BLOG_DEPLOY_HOOK_URL is set, so the static site was not rebuilt. The post is live in the API and will appear in search results after the next deploy.",
    };
  }

  // AbortSignal.timeout rather than a manual setTimeout: Node clears the timer
  // itself when the fetch settles, so a slow hook cannot keep the event loop
  // alive after the request is done with.
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    logger.warn(`[deploy-hook] ${config.blog.deployHookUrl}`)
    const response = await fetch(config.blog.deployHookUrl, {
      method: "POST",
      // Netlify ignores the body, Vercel ignores it, Cloudflare ignores it. Sent
      // anyway so the reason shows up in whatever the host logs about the build.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger_title: `Splitly blog — ${why}` }),
      signal,
    });

    if (!response.ok) {
      logger.warn(`[deploy-hook] ${response.status} ${response.statusText} for: ${why}`);
      return {
        triggered: false,
        reason: `The rebuild could not be started (${response.status}). The post is live in the API; deploy manually so it reaches search engines.`,
      };
    }

    logger.info(`[deploy-hook] Rebuild requested: ${why}`);
    return { triggered: true, reason: null };
  } catch (error) {
    /**
     * Includes the timeout, DNS failure, and a firewall with no egress. All the
     * same to the caller: the build did not start and a human has to deploy.
     */
    logger.warn(`[deploy-hook] Failed to reach the deploy hook: ${error.message}`);
    return {
      triggered: false,
      reason:
        "The rebuild could not be started — the deploy hook did not respond. The post is live in the API; deploy manually so it reaches search engines.",
    };
  }
};

module.exports = { trigger, isConfigured };
