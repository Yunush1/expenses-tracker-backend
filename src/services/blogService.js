const blogRepository = require("../repositories/blogRepository");
const deployHookService = require("./deployHookService");
const { sanitizeHtml, htmlToText } = require("../utils/sanitizeHtml");
const { slugify } = require("../validators/blogValidators");
const { BLOG_STATUS, LIMITS, ERROR_CODES } = require("../constants");
const { NotFoundError, ConflictError, BadRequestError } = require("../errors");

/**
 * Blog rules (docs/23-BLOG.md).
 *
 * Three things live here rather than in the controller or the model, because
 * each is a decision rather than a transformation:
 *
 *  1. **What a post's URL is**, including what happens when it changes.
 *  2. **Whether a draft is fit to publish**, which is a checklist rather than a
 *     schema — it produces a list of reasons, not a single field error.
 *  3. **That publishing has a side effect outside this process** — the rebuild
 *     without which a published post is not crawlable.
 */

/* --------------------------- Derived fields ---------------------------- */

/**
 * The reading-time estimate, from the sanitised body.
 *
 * Computed on save rather than on read so a listing of twelve posts does not
 * parse twelve articles to print twelve labels. Recomputed on every content
 * write, so it cannot go stale against the text.
 */
const readingStats = (contentHtml) => {
  const text = htmlToText(contentHtml);
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return { wordCount, readingMinutes: Math.max(1, Math.round(wordCount / LIMITS.BLOG_WPM)) };
};

/**
 * The first ~30 words of the body, when the author has not written an excerpt.
 *
 * A fallback, not a default: an excerpt is the text under the H1 and the card
 * copy in the index, and an author's own sentence beats a truncated opening
 * paragraph every time. But an empty one leaves visible gaps on two screens, and
 * a gap is worse than a decent guess.
 *
 * Deliberately **not** used for `metaDescription` — see `metaFor` below.
 */
const excerptFrom = (contentHtml) => {
  const text = htmlToText(contentHtml);
  if (!text) return "";

  if (text.length <= LIMITS.BLOG_EXCERPT_MAX) return text;

  // Cut on a word boundary, then on a sentence boundary if one is close enough,
  // so the excerpt ends somewhere a human would have ended it.
  const clipped = text.slice(0, LIMITS.BLOG_EXCERPT_MAX - 1);
  const lastStop = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("? "), clipped.lastIndexOf("! "));
  if (lastStop > LIMITS.BLOG_EXCERPT_MAX * 0.6) return clipped.slice(0, lastStop + 1);

  return `${clipped.slice(0, clipped.lastIndexOf(" "))}…`;
};

/**
 * The head tags for a post, resolved once so the API, the React route and the
 * build-time pre-renderer cannot disagree.
 *
 * ## Why the meta description falls back to the excerpt and not to the body
 *
 * Google rewrites a description it considers unhelpful, and a truncated first
 * paragraph is the archetype of one — it usually opens with scene-setting rather
 * than with what the page answers. The excerpt is at least a human's summary. If
 * neither exists the field is left **empty**, which is the honest outcome:
 * Google will compose a snippet from the page, and an empty tag is better than a
 * bad one because a bad one gets used.
 */
const metaFor = (post) => ({
  metaTitle: post.metaTitle?.trim() || post.title,
  metaDescription: post.metaDescription?.trim() || post.excerpt?.trim() || "",
});

/* ------------------------------- Slugs --------------------------------- */

/**
 * A free address derived from the title, for a post being created without one.
 *
 * Appends `-2`, `-3` … on collision. That suffix is a compromise and only
 * applies to **auto-generated** slugs: an author who typed a slug that is taken
 * gets a conflict error instead (see `assertSlugFree`), because silently moving
 * their post to a different URL than the one they chose is exactly the surprise
 * that ends with the wrong address being shared.
 */
const deriveSlug = async (title, exceptId = null) => {
  const base = slugify(title) || "post";
  if (!(await blogRepository.slugExists(base, exceptId))) return base;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base.slice(0, LIMITS.BLOG_SLUG_MAX - 4)}-${suffix}`;
    if (!(await blogRepository.slugExists(candidate, exceptId))) return candidate;
  }

  // A hundred posts with the same title is not a collision, it is a mistake.
  throw new ConflictError(
    "Too many posts share this title. Give this one a different URL.",
    ERROR_CODES.BLOG_SLUG_TAKEN
  );
};

const assertSlugFree = async (slug, exceptId = null) => {
  if (await blogRepository.slugExists(slug, exceptId)) {
    throw new ConflictError(
      `The URL /blog/${slug} is already used by another post — including one that used to live there.`,
      ERROR_CODES.BLOG_SLUG_TAKEN
    );
  }
};

/* ----------------------------- Readiness -------------------------------- */

/**
 * What is missing before this post should be public.
 *
 * Returned as a list rather than thrown as a single error, and surfaced by the
 * editor *while writing* rather than only at the publish button — a checklist
 * that appears at the moment of publishing is a checklist that gets overridden.
 *
 * ## Why these five and not a longer list
 *
 * Each one is a defect a reader or a crawler actually experiences:
 *
 * - **No body**: an empty page in the index.
 * - **Under 300 words**: the length below which a page is competing for a query
 *   it cannot answer. Not a Google threshold — there is no such number — but a
 *   reliable marker of a page that will not rank and will dilute the ones that
 *   do.
 * - **No meta description**: Google writes one for you, from whatever it finds.
 * - **No cover image**: every share of the link previews as a bare logo.
 * - **No H2**: a wall of paragraphs, unskimmable, and with nothing for a
 *   featured snippet to attach to.
 *
 * Everything else the editor scores is advice. These are the ones worth blocking
 * on — and even these are warnings the author may publish through, because the
 * alternative is an editor that refuses to publish a two-paragraph announcement.
 */
const readinessIssues = (post) => {
  const issues = [];
  const { metaDescription } = metaFor(post);
  const { wordCount } = readingStats(post.contentHtml);

  if (!htmlToText(post.contentHtml)) issues.push("The post has no content yet.");
  else if (wordCount < 300) {
    issues.push(
      `Only ${wordCount} words. Short posts rarely rank — aim for 700+ on anything you want traffic from.`
    );
  }

  if (!metaDescription) {
    issues.push("No meta description, so Google will invent the text under your search result.");
  } else if (metaDescription.length > 160) {
    issues.push(
      `The meta description is ${metaDescription.length} characters and will be cut off around 160.`
    );
  }

  if (!post.coverImage) issues.push("No cover image, so shared links preview as a bare logo.");
  else if (!post.coverImageAlt?.trim()) issues.push("The cover image has no alt text.");

  if (!/<h2[\s>]/i.test(post.contentHtml || "")) {
    issues.push("No subheadings (H2). Long text with no headings is hard to skim and to rank.");
  }

  const { metaTitle } = metaFor(post);
  if (metaTitle.length > 60) {
    issues.push(`The SEO title is ${metaTitle.length} characters and will be cut off around 60.`);
  }

  if (post.focusKeyword?.trim()) {
    const keyword = post.focusKeyword.trim().toLowerCase();
    if (!metaTitle.toLowerCase().includes(keyword)) {
      issues.push(`The focus keyword "${post.focusKeyword}" is not in the SEO title.`);
    }
    if (!post.slug?.includes(slugify(keyword))) {
      issues.push(`The focus keyword "${post.focusKeyword}" is not in the URL.`);
    }
  }

  return issues;
};

/* ------------------------------- Writes --------------------------------- */

/**
 * The fields that come off a request, normalised.
 *
 * `contentHtml` goes through the sanitiser **here**, on the way in, so that
 * every read path — the API, the pre-renderer, the sitemap — is reading a value
 * that has already been cleaned. Sanitising on output instead would mean doing
 * it in three places and getting it wrong in one.
 */
const applyFields = (post, fields) => {
  const contentChanged = fields.contentHtml !== undefined;

  if (fields.title !== undefined) post.title = fields.title;
  if (fields.metaTitle !== undefined) post.metaTitle = fields.metaTitle;
  if (fields.metaDescription !== undefined) post.metaDescription = fields.metaDescription;
  if (fields.coverImage !== undefined) post.coverImage = fields.coverImage;
  if (fields.coverImageAlt !== undefined) post.coverImageAlt = fields.coverImageAlt;
  if (fields.focusKeyword !== undefined) post.focusKeyword = fields.focusKeyword;
  if (fields.canonicalUrl !== undefined) post.canonicalUrl = fields.canonicalUrl;
  if (fields.noindex !== undefined) post.noindex = fields.noindex;
  if (fields.authorName !== undefined) post.authorName = fields.authorName;
  if (fields.faqs !== undefined) post.faqs = fields.faqs;

  if (fields.tags !== undefined) {
    // De-duplicated after lowercasing, so "Rent" and "rent" cannot both appear
    // and produce two tag pages for one topic — which is a duplicate-content
    // problem, not a cosmetic one.
    post.tags = [...new Set(fields.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  }

  if (contentChanged) {
    post.contentHtml = sanitizeHtml(fields.contentHtml);
    post.wordCount = readingStats(post.contentHtml).wordCount;
  }

  // After the body, so the fallback reads the new text rather than the old.
  if (fields.excerpt !== undefined) post.excerpt = fields.excerpt;
  if (!post.excerpt?.trim()) post.excerpt = excerptFrom(post.contentHtml);

  /**
   * `contentUpdatedAt` moves only for changes a reader can see.
   *
   * It feeds `dateModified` in the structured data. Moving it when someone fixes
   * a tag or toggles `noindex` would republish an unchanged article to every
   * search engine, which at best wastes crawl budget and at worst reads as the
   * date manipulation that thin-content sites do.
   */
  const visibleChange =
    contentChanged ||
    fields.title !== undefined ||
    fields.excerpt !== undefined ||
    fields.coverImage !== undefined ||
    fields.faqs !== undefined;

  if (visibleChange) post.contentUpdatedAt = new Date();

  return post;
};

const createPost = async (fields, user) => {
  const slug = fields.slug
    ? (await assertSlugFree(fields.slug), fields.slug)
    : await deriveSlug(fields.title);

  const post = applyFields(
    {
      slug,
      status: BLOG_STATUS.DRAFT,
      previousSlugs: [],
      authorUserId: user?._id || null,
      authorName: fields.authorName || user?.name || "",
    },
    fields
  );

  return blogRepository.create(post);
};

const getPostForAdmin = async (id) => {
  const post = await blogRepository.findById(id);
  if (!post) throw new NotFoundError("That post no longer exists.", ERROR_CODES.BLOG_POST_NOT_FOUND);
  return post;
};

/**
 * Edit a post.
 *
 * ## Why a slug change is recorded rather than simply applied
 *
 * The old URL is in search results, in other people's links, and in the browser
 * history of everyone who has read it. Dropping it turns all of those into 404s
 * and discards whatever ranking the page had earned. Pushing it onto
 * `previousSlugs` lets the read path answer with a 301, which is the one
 * response that transfers ranking to the new address.
 *
 * The old slug is then **reserved forever** — `slugExists` checks the history
 * too — so a later post cannot claim it and inherit redirects meant for
 * something else.
 */
const updatePost = async (id, fields) => {
  const post = await getPostForAdmin(id);

  if (fields.slug && fields.slug !== post.slug) {
    await assertSlugFree(fields.slug, post._id);

    // Only a *published* post has an address worth preserving. Renaming a draft
    // that nobody has seen should not litter the history with dead URLs.
    if (post.status === BLOG_STATUS.PUBLISHED && !post.previousSlugs.includes(post.slug)) {
      post.previousSlugs.push(post.slug);
    }
    post.slug = fields.slug;
  }

  applyFields(post, fields);
  await post.save();

  /**
   * A rebuild for an edit, but only to a post that is actually live.
   *
   * Editing a draft changes nothing a crawler can see, so firing the hook would
   * spend a build on nothing — and an author saving every thirty seconds would
   * spend a lot of them.
   */
  const deploy =
    post.status === BLOG_STATUS.PUBLISHED
      ? await deployHookService.trigger(`updated "${post.title}"`)
      : { triggered: false, reason: null };

  return { post, deploy };
};

/**
 * Make a post public.
 *
 * Two facts, in this order: the row flips, then the site rebuilds. The order
 * matters — a rebuild that ran first would export the archive without this post
 * in it, and report success.
 */
const publishPost = async (id) => {
  const post = await getPostForAdmin(id);

  if (!htmlToText(post.contentHtml)) {
    throw new BadRequestError("There is nothing in this post to publish yet.");
  }

  const wasPublished = post.status === BLOG_STATUS.PUBLISHED;

  post.status = BLOG_STATUS.PUBLISHED;
  // Set once and never re-stamped. See models/blogPost.js — a publication date
  // that moves on every edit is what a content farm looks like.
  if (!post.publishedAt) post.publishedAt = new Date();

  /**
   * A post cannot have been modified before it existed publicly.
   *
   * `contentUpdatedAt` starts moving as soon as the draft is written, which is
   * usually *earlier* than the publish date — so left alone it emits a
   * `dateModified` preceding `datePublished`. That pair is incoherent, and
   * Google's Rich Results test reports it as an error on the article markup,
   * which is enough to cost the rich result the FAQ block is there to earn.
   *
   * Clamped rather than reset on every publish: a genuine edit *after*
   * publication must keep its own later timestamp, because that is the freshness
   * signal the field exists to carry.
   */
  if (!post.contentUpdatedAt || post.contentUpdatedAt < post.publishedAt) {
    post.contentUpdatedAt = post.publishedAt;
  }

  await post.save();

  const deploy = await deployHookService.trigger(
    wasPublished ? `re-published "${post.title}"` : `published "${post.title}"`
  );

  return { post, deploy, issues: readinessIssues(post) };
};

/**
 * Take a post out of the public archive.
 *
 * The row survives and the slug stays reserved, so the address cannot be reused
 * and the post can go back up unchanged. A rebuild follows, because until it
 * runs the pre-rendered HTML is still on the CDN and still being served — the
 * database flip alone unpublishes nothing that a crawler can see.
 */
const unpublishPost = async (id) => {
  const post = await getPostForAdmin(id);
  post.status = BLOG_STATUS.DRAFT;
  await post.save();

  const deploy = await deployHookService.trigger(`unpublished "${post.title}"`);
  return { post, deploy };
};

/**
 * Delete a post.
 *
 * The images it used are deliberately **not** deleted with it. They are content-
 * addressed and may be referenced by another post, and an orphaned file costs a
 * few kilobytes while a wrongly deleted one breaks a live article — so the
 * asymmetry runs towards keeping them.
 */
const deletePost = async (id) => {
  const post = await getPostForAdmin(id);
  const wasPublished = post.status === BLOG_STATUS.PUBLISHED;
  const title = post.title;

  await blogRepository.deleteById(id);

  const deploy = wasPublished
    ? await deployHookService.trigger(`deleted "${title}"`)
    : { triggered: false, reason: null };

  return { deploy };
};

/* -------------------------------- Reads --------------------------------- */

/**
 * A published post by slug, or the redirect that replaces it.
 *
 * Returns `{ post }` or `{ redirectTo }`. The caller turns the second into a 301
 * — never a 302: a temporary redirect tells search engines to keep the old URL
 * indexed, which is the opposite of what a rename means.
 */
const getPublishedBySlug = async (slug) => {
  const post = await blogRepository.findPublishedBySlug(slug);
  if (post) {
    blogRepository.incrementViews(post._id);
    return { post };
  }

  const renamed = await blogRepository.findByPreviousSlug(slug);
  if (renamed) return { redirectTo: renamed.slug };

  throw new NotFoundError("That post doesn't exist.", ERROR_CODES.BLOG_POST_NOT_FOUND);
};

/**
 * The "keep reading" list: posts sharing a tag, topped up with recent ones.
 *
 * Topped up rather than left short, because the block is how a reader gets to a
 * second article and how a crawler finds the rest of the archive. A post with an
 * unusual tag would otherwise be a dead end.
 */
const getRelated = async (post, limit = 3) => {
  const related = await blogRepository.findRelated(post, limit);
  if (related.length >= limit) return related;

  const exclude = [post._id, ...related.map((item) => item._id)];
  const filler = await blogRepository.findRecent(exclude, limit - related.length);

  return [...related, ...filler];
};

module.exports = {
  createPost,
  updatePost,
  publishPost,
  unpublishPost,
  deletePost,
  getPostForAdmin,
  getPublishedBySlug,
  getRelated,
  readinessIssues,
  readingStats,
  metaFor,
  listPublished: blogRepository.listPublished,
  listAll: blogRepository.listAll,
  listForRender: blogRepository.listForRender,
  listTags: blogRepository.listTags,
};
