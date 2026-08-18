const BlogPost = require("../models/blogPost");
const { BLOG_STATUS } = require("../constants");

/**
 * Every query the blog makes, in one place (docs/23-BLOG.md).
 *
 * ## The rule this file exists to enforce
 *
 * **A public read never returns a draft.** That is one condition, repeated
 * across the listing, the single-post fetch, the tag pages, the sitemap feed and
 * the build-time export — five call sites, of which four would still look
 * correct in review if the filter were missing. Keeping the query here means the
 * status filter is written once and cannot be forgotten by the fifth.
 *
 * The failure it prevents is specific and expensive: an unfinished draft served
 * to a crawler is indexed as-is, and the half-written version can outrank the
 * finished one for weeks afterwards.
 */

/** The condition. Never inline this — see above. */
const PUBLIC = Object.freeze({ status: BLOG_STATUS.PUBLISHED });

/**
 * Fields a listing needs, and the one it must not carry.
 *
 * `contentHtml` is excluded. A twelve-post index page would otherwise transfer
 * every word of twelve articles to render twelve cards, which on a blog with
 * long posts is megabytes of JSON for a page that shows two lines of each.
 */
const LIST_FIELDS =
  "slug title metaTitle metaDescription excerpt coverImage coverImageAlt tags status publishedAt contentUpdatedAt updatedAt authorName wordCount noindex views";

const findBySlug = (slug) => BlogPost.findOne({ slug: String(slug).toLowerCase() });

/** Published only — the public single-post read. */
const findPublishedBySlug = (slug) =>
  BlogPost.findOne({ ...PUBLIC, slug: String(slug).toLowerCase() });

/**
 * A post that used to live at this address.
 *
 * Separate from `findPublishedBySlug` and always tried *second*, because a live
 * slug must win over a historical one: if a post is renamed and a later post
 * takes the freed address, the new occupant is the correct answer and the
 * redirect is not.
 */
const findByPreviousSlug = (slug) =>
  BlogPost.findOne({ ...PUBLIC, previousSlugs: String(slug).toLowerCase() });

/** Does any post — draft or published — already own this address? */
const slugExists = async (slug, exceptId = null) => {
  const query = {
    $or: [{ slug: String(slug).toLowerCase() }, { previousSlugs: String(slug).toLowerCase() }],
  };
  if (exceptId) query._id = { $ne: exceptId };
  return Boolean(await BlogPost.exists(query));
};

/**
 * The public index, newest first.
 *
 * Sorted by `publishedAt` and not by `createdAt`: a post written in January and
 * published today belongs at the top, which is the whole reason the two dates
 * are separate fields (models/blogPost.js).
 */
const listPublished = async ({ page = 1, limit = 12, tag = null } = {}) => {
  const filter = { ...PUBLIC };
  if (tag) filter.tags = tag;

  const [items, total] = await Promise.all([
    BlogPost.find(filter)
      .select(LIST_FIELDS)
      .sort({ publishedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    BlogPost.countDocuments(filter),
  ]);

  return { items, total };
};

/**
 * The admin index — drafts included, optionally searched.
 *
 * Sorted by `updatedAt`, not `publishedAt`, because this list answers "what was
 * I working on" rather than "what is live", and most drafts have no publish date
 * at all to sort by.
 */
const listAll = async ({ page = 1, limit = 20, status = null, q = null } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (q) filter.$text = { $search: q };

  const [items, total] = await Promise.all([
    BlogPost.find(filter)
      .select(LIST_FIELDS)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    BlogPost.countDocuments(filter),
  ]);

  return { items, total };
};

/**
 * Everything a crawler-facing renderer needs, in one query.
 *
 * Read by the sitemap and by the frontend's build-time pre-renderer, which fetch
 * the whole published archive at once — deliberately unpaginated, because a
 * sitemap that stops at page one is a sitemap that hides the rest of the site.
 * `noindex` posts are included and flagged rather than filtered, so the consumer
 * can render the page while leaving it out of the sitemap; the two decisions are
 * not the same.
 */
const listForRender = () =>
  BlogPost.find(PUBLIC)
    .select(
      "slug title metaTitle metaDescription excerpt contentHtml coverImage coverImageAlt tags publishedAt contentUpdatedAt authorName faqs canonicalUrl noindex wordCount"
    )
    .sort({ publishedAt: -1 })
    .lean();

/**
 * Other published posts sharing a tag, for the "keep reading" block.
 *
 * Internal links are how a crawler discovers an archive and how authority moves
 * between its pages — the same argument `ContentPage.jsx` makes for the static
 * pages. A blog whose posts link only back to the index is a blog of orphans.
 */
const findRelated = (post, limit = 3) =>
  BlogPost.find({
    ...PUBLIC,
    _id: { $ne: post._id },
    ...(post.tags?.length ? { tags: { $in: post.tags } } : {}),
  })
    .select(LIST_FIELDS)
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean();

/** Newest published posts, used to backfill "keep reading" when tags find too few. */
const findRecent = (excludeIds = [], limit = 3) =>
  BlogPost.find({ ...PUBLIC, _id: { $nin: excludeIds } })
    .select(LIST_FIELDS)
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean();

const create = (data) => BlogPost.create(data);

const findById = (id) => BlogPost.findById(id);

const deleteById = (id) => BlogPost.findByIdAndDelete(id);

/**
 * Bump the view counter without touching `updatedAt`.
 *
 * `timestamps: false` on the update is the point. Without it, every page load
 * would move `updatedAt`, and the admin list — which sorts by it — would reorder
 * itself according to what readers were reading rather than what the author last
 * edited. It would also make `dateModified` in the structured data meaningless,
 * which is a real SEO cost: a freshness signal that ticks on every request tells
 * a search engine nothing.
 */
const incrementViews = (id) =>
  BlogPost.updateOne({ _id: id }, { $inc: { views: 1 } }, { timestamps: false }).catch(() => {});

/** Distinct tags across published posts, for the index's filter row. */
const listTags = () => BlogPost.distinct("tags", PUBLIC);

module.exports = {
  findBySlug,
  findPublishedBySlug,
  findByPreviousSlug,
  slugExists,
  listPublished,
  listAll,
  listForRender,
  findRelated,
  findRecent,
  create,
  findById,
  deleteById,
  incrementViews,
  listTags,
};
