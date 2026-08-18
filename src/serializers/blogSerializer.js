const { LIMITS } = require("../constants");

/**
 * Blog DTOs (docs/23-BLOG.md §7).
 *
 * ## Two shapes, and why the public one is not just the admin one with fields removed
 *
 * `toPublicPostDTO` is what a reader — and therefore a crawler, and therefore the
 * build-time pre-renderer — receives. `toAdminPostDTO` is what the editor
 * receives. They are written separately rather than as a filter over one object
 * because the fields that must never leak are the kind that get re-added by
 * accident: `authorUserId` is an internal identifier, `views` is a number that
 * flatters or embarrasses nobody usefully, and a draft's `contentHtml` is
 * unfinished writing that would be indexed verbatim if it ever escaped.
 *
 * A single serializer with an `isAdmin` flag would put those decisions behind a
 * boolean that one wrong call site inverts.
 */

const id = (value) => (value ? String(value) : null);

const readingMinutes = (wordCount = 0) => Math.max(1, Math.round(wordCount / LIMITS.BLOG_WPM));

/**
 * The head tags, resolved server-side.
 *
 * Sent as explicit fields rather than left for each client to derive, because
 * there are three renderers — the React route, the build-time pre-renderer and
 * any future one — and a fallback rule implemented three times is a rule that
 * differs in the third. HTML that disagrees with what the user sees is cloaking
 * (docs/15-SEO.md §3), and this is the cheapest way to make that impossible.
 */
const seoFor = (post) => ({
  metaTitle: post.metaTitle?.trim() || post.title,
  metaDescription: post.metaDescription?.trim() || post.excerpt?.trim() || "",
  canonicalUrl: post.canonicalUrl || "",
  noindex: Boolean(post.noindex),
});

/** The card in a listing. No body — see blogRepository.LIST_FIELDS. */
const toCardDTO = (post) => ({
  id: id(post._id),
  slug: post.slug,
  title: post.title,
  excerpt: post.excerpt || "",
  coverImage: post.coverImage || "",
  coverImageAlt: post.coverImageAlt || "",
  tags: post.tags || [],
  publishedAt: post.publishedAt,
  updatedAt: post.contentUpdatedAt || post.updatedAt,
  authorName: post.authorName || "",
  readingMinutes: readingMinutes(post.wordCount),
});

/** A full published article. */
const toPublicPostDTO = (post, related = []) => ({
  ...toCardDTO(post),
  contentHtml: post.contentHtml || "",
  wordCount: post.wordCount || 0,
  faqs: (post.faqs || []).map((faq) => ({ q: faq.q, a: faq.a })),
  seo: seoFor(post),
  related: related.map(toCardDTO),
});

/**
 * Everything the editor needs to load a post back into the form.
 *
 * `issues` is attached by the controller rather than computed here: it is a
 * judgement about the post, not a rendering of it, and it lives in the service
 * where the thresholds are documented.
 */
const toAdminPostDTO = (post) => ({
  id: id(post._id),
  slug: post.slug,
  previousSlugs: post.previousSlugs || [],
  title: post.title,
  metaTitle: post.metaTitle || "",
  metaDescription: post.metaDescription || "",
  excerpt: post.excerpt || "",
  contentHtml: post.contentHtml || "",
  coverImage: post.coverImage || "",
  coverImageAlt: post.coverImageAlt || "",
  tags: post.tags || [],
  focusKeyword: post.focusKeyword || "",
  faqs: (post.faqs || []).map((faq) => ({ q: faq.q, a: faq.a })),
  canonicalUrl: post.canonicalUrl || "",
  noindex: Boolean(post.noindex),
  status: post.status,
  publishedAt: post.publishedAt,
  contentUpdatedAt: post.contentUpdatedAt,
  createdAt: post.createdAt,
  updatedAt: post.updatedAt,
  authorName: post.authorName || "",
  wordCount: post.wordCount || 0,
  readingMinutes: readingMinutes(post.wordCount),
  views: post.views || 0,
  /** The resolved tags, so the editor can preview the exact search result. */
  seo: seoFor(post),
});

/** The admin list row — a card plus the operational columns. */
const toAdminCardDTO = (post) => ({
  ...toCardDTO(post),
  status: post.status,
  noindex: Boolean(post.noindex),
  views: post.views || 0,
  wordCount: post.wordCount || 0,
});

/**
 * The whole published archive, for the build-time pre-renderer.
 *
 * Its own shape because that consumer runs in Node inside a Vite config, has no
 * React and no client helpers, and needs every field it will write into static
 * HTML in one flat object — including the ones a browser derives at runtime.
 * `noindex` is carried through rather than filtered on, so the build can render
 * the page and still leave it out of the sitemap.
 */
const toRenderDTO = (post) => ({
  slug: post.slug,
  title: post.title,
  excerpt: post.excerpt || "",
  contentHtml: post.contentHtml || "",
  coverImage: post.coverImage || "",
  coverImageAlt: post.coverImageAlt || "",
  tags: post.tags || [],
  publishedAt: post.publishedAt,
  updatedAt: post.contentUpdatedAt || post.updatedAt,
  authorName: post.authorName || "",
  readingMinutes: readingMinutes(post.wordCount),
  wordCount: post.wordCount || 0,
  faqs: (post.faqs || []).map((faq) => ({ q: faq.q, a: faq.a })),
  ...seoFor(post),
});

module.exports = {
  toCardDTO,
  toPublicPostDTO,
  toAdminPostDTO,
  toAdminCardDTO,
  toRenderDTO,
  seoFor,
};
