const mongoose = require("mongoose");

const { BLOG_STATUS, LIMITS } = require("../constants");

/**
 * One article (docs/23-BLOG.md).
 *
 * ## Why this collection is not `seo/pages.js` with a database behind it
 *
 * The existing marketing pages live in a frontend data file, and they are right
 * to: there are seven of them, they change a few times a year, and keeping them
 * in the repo means a page and the code that renders it are reviewed together.
 * A blog inverts every one of those properties — daily writes, by a person who
 * is not deploying, in prose that has no business in a pull request.
 *
 * What survives the move is the *rendering* contract. Both kinds of page end up
 * as pre-rendered static HTML with the same head tags and the same JSON-LD
 * shape, because a crawler must not be able to tell which of the two it is
 * reading. The difference is only where the words are stored.
 *
 * ## Why the slug is the identity and the `_id` is not
 *
 * `/blog/how-to-split-rent` is the URL that accumulates links and ranking, so
 * the slug is a real key with a real unique index, and it is the handle every
 * public route resolves by. An ObjectId in the URL would be shorter to implement
 * and worth nothing to a search engine.
 *
 * The consequence is that **changing a slug moves a page**. That is a genuine
 * cost — inbound links break and the ranking history is lost — so it is allowed
 * but recorded: `previousSlugs` keeps every address this post has ever had, and
 * the read path redirects them (301) rather than 404ing. A blog that cannot fix
 * a typo in a URL is worse than one that can, provided the old address keeps
 * working forever.
 *
 * ## Fields that exist purely because search engines read them
 *
 * `metaTitle` and `metaDescription` are separate from `title` and `excerpt` on
 * purpose. The words that work in a search result are shorter and more literal
 * than the words that work on the page — "Split Rent With Roommates: 2026 Guide"
 * versus "Nobody wants to be the one chasing the rent". Collapsing them into one
 * field forces every post to compromise one of the two, and the compromise is
 * always paid by the SERP.
 */

const faqSchema = new mongoose.Schema(
  {
    q: { type: String, required: true, trim: true, maxlength: LIMITS.BLOG_FAQ_Q_MAX },
    a: { type: String, required: true, trim: true, maxlength: LIMITS.BLOG_FAQ_A_MAX },
  },
  { _id: false }
);

const blogPostSchema = new mongoose.Schema(
  {
    /**
     * The URL segment. Lowercase, hyphenated, unique across every post.
     *
     * Uniqueness is enforced by an index rather than by a read-then-write in the
     * service, because two operators saving at once is exactly when a check-then-
     * insert loses — and the loser would silently overwrite the winner's URL.
     */
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: LIMITS.BLOG_SLUG_MIN,
      maxlength: LIMITS.BLOG_SLUG_MAX,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },

    /**
     * Every address this post has answered to, so an old link keeps working.
     *
     * Indexed, because the redirect lookup runs on every request that misses the
     * primary slug — which, after a rename, includes every visitor arriving from
     * an existing search result.
     */
    previousSlugs: {
      type: [String],
      default: [],
      index: true,
    },

    /** The `<h1>`. What the article is called on the page. */
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: LIMITS.BLOG_TITLE_MAX,
    },

    /** The `<title>` tag. Falls back to `title` when the author leaves it blank. */
    metaTitle: { type: String, trim: true, default: "", maxlength: LIMITS.BLOG_META_TITLE_MAX },
    metaDescription: {
      type: String,
      trim: true,
      default: "",
      maxlength: LIMITS.BLOG_META_DESC_MAX,
    },

    /** The standfirst under the H1, and the card text in the index. */
    excerpt: { type: String, trim: true, default: "", maxlength: LIMITS.BLOG_EXCERPT_MAX },

    /**
     * The article body, as sanitised HTML.
     *
     * Stored rendered rather than as Markdown or as TinyMCE's raw output. The
     * pre-renderer in the frontend build writes this string straight into a
     * static page, so anything it would have to interpret at build time is a
     * second renderer that can disagree with the browser's — the cloaking hazard
     * docs/15-SEO.md §3 exists to avoid.
     *
     * **Never assign to this field directly.** It passes through
     * `utils/sanitizeHtml` in the service; the model cannot enforce that, which
     * is why it is written here where anyone adding a write path will read it.
     */
    contentHtml: { type: String, default: "", maxlength: LIMITS.BLOG_CONTENT_MAX },

    /** Words, cached at save time so a listing does not have to parse every body. */
    wordCount: { type: Number, default: 0 },

    /**
     * The share card and the in-article hero, as a URL this server produced.
     *
     * A per-post image is the single biggest lever on click-through from social
     * and chat, which is why it is a first-class field rather than "the first
     * image in the body" — that heuristic breaks the moment a post opens with a
     * table.
     */
    coverImage: { type: String, default: "" },
    coverImageAlt: { type: String, trim: true, default: "", maxlength: 300 },

    tags: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: LIMITS.BLOG_TAG_MAX }],
      default: [],
    },

    /**
     * The phrase this post is trying to rank for.
     *
     * Never rendered. It exists so the editor can score the draft against it —
     * is it in the title, the first paragraph, a heading, the slug — and so a
     * second post targeting the same phrase is visible as the duplication it is.
     * Stuffing it into a meta keywords tag would do nothing; Google has ignored
     * that tag since 2009.
     */
    focusKeyword: { type: String, trim: true, default: "", maxlength: 120 },

    /** Rendered as an FAQPage rich result when present (seo/schema.js). */
    faqs: { type: [faqSchema], default: [] },

    /**
     * Points somewhere else when this article is a republication.
     *
     * Empty for anything original, in which case the page canonicalises to
     * itself. A wrong value here removes the page from the index entirely, so it
     * is validated as an absolute URL and left alone otherwise.
     */
    canonicalUrl: { type: String, trim: true, default: "" },

    /**
     * Published but deliberately not indexed.
     *
     * For the pages every site needs and no site wants ranked — a thin
     * announcement, a landing page for one campaign, a post kept live only
     * because something links to it. Separate from DRAFT, which is not public at
     * all.
     */
    noindex: { type: Boolean, default: false },

    status: {
      type: String,
      enum: Object.values(BLOG_STATUS),
      default: BLOG_STATUS.DRAFT,
      index: true,
    },

    /**
     * When it went live — **not** `createdAt`.
     *
     * This is the date in the article's byline and in `datePublished`, and it is
     * set on the first transition to PUBLISHED and then left alone. A post
     * drafted in January and published in March is a March article, and
     * re-stamping it on every subsequent edit would tell search engines the
     * publication date moves, which is what a content farm looks like.
     */
    publishedAt: { type: Date, default: null },

    /**
     * The last edit that changed what a reader sees.
     *
     * Distinct from Mongoose's `updatedAt`, which moves for any write at all —
     * including the view counter below. `dateModified` in the structured data
     * reads this one, because a freshness signal that ticks every time somebody
     * loads the page is a freshness signal that means nothing.
     */
    contentUpdatedAt: { type: Date, default: null },

    /** Display only: the byline. */
    authorName: { type: String, trim: true, default: "", maxlength: 120 },
    /** Who actually wrote it, for the audit trail. Never rendered. */
    authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    /**
     * A rough popularity signal for ordering "related posts".
     *
     * Incremented without a session and without deduplication, so it is a
     * counter, not analytics — treated as a hint and never shown as a number,
     * because "read 4 times" undersells an article more than it informs anyone.
     */
    views: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * The public listing's exact query: published posts, newest first.
 *
 * Compound and ordered to match, so the index satisfies both the filter and the
 * sort — without it, every page of the blog index is a collection scan followed
 * by an in-memory sort, which is fine at ten posts and not at a thousand.
 */
blogPostSchema.index({ status: 1, publishedAt: -1 });

/** Tag pages, same shape. */
blogPostSchema.index({ status: 1, tags: 1, publishedAt: -1 });

/**
 * Search across the admin list, so an operator with two hundred drafts can find
 * one. Text rather than a regex scan: a regex on `title` cannot use an index and
 * degrades exactly as the archive grows.
 */
blogPostSchema.index({ title: "text", excerpt: "text", focusKeyword: "text" });

module.exports = mongoose.model("BlogPost", blogPostSchema);
