const { z } = require("zod");

const { BLOG_STATUS, LIMITS } = require("../constants");

/**
 * Request shapes for the blog (docs/23-BLOG.md).
 *
 * ## Why almost everything is optional
 *
 * A post is written over several sittings — a title today, three paragraphs
 * tomorrow, the meta description when it is nearly finished. A create schema
 * that demanded a body and a description would force the author to fake both to
 * get a draft saved, and the fakes are what would end up published.
 *
 * So validation here answers "is this storable", and the *publish* endpoint
 * answers "is this fit to be public" — that second, stricter check lives in the
 * service, where it can produce a list of what is missing rather than a single
 * field error. The two are different questions and conflating them makes drafts
 * hostile to write.
 */

/**
 * The URL segment, normalised rather than merely checked.
 *
 * An author typing "Split Rent With Roommates!" into the slug field means
 * `split-rent-with-roommates`, and refusing it with a regex error teaches them
 * to go and find the rules. Transformation is safe here because the result is
 * verified against the pattern afterwards — anything that cannot be made into a
 * slug still fails.
 */
const slugify = (value) =>
  String(value)
    .normalize("NFKD")
    // Strip combining marks so "café" becomes "cafe" rather than losing the "e".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.BLOG_SLUG_MAX)
    // A trailing hyphen can survive the slice above.
    .replace(/-+$/g, "");

const slug = z
  .string()
  .transform(slugify)
  .refine((value) => value.length >= LIMITS.BLOG_SLUG_MIN, {
    message: `The URL needs at least ${LIMITS.BLOG_SLUG_MIN} letters or numbers`,
  })
  .refine((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), {
    message: "The URL may only contain lowercase letters, numbers and hyphens",
  });

/**
 * An absolute http(s) URL, or empty.
 *
 * Only used for `canonicalUrl`, where a relative value is meaningless — a
 * canonical tag is read by crawlers that have no page context to resolve it
 * against — and a wrong one removes the page from the index entirely.
 */
const absoluteUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => {
      if (!value) return true;
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "Enter a full URL starting with https://, or leave it blank" }
  );

/**
 * A path this server produced (`/uploads/blog/...`), or empty.
 *
 * Not a general URL. A cover image pointing at another host makes every reader
 * of the article send that host a request, with their IP and a referrer naming
 * the page — and leaves the article's illustration under someone else's control.
 * The upload endpoint is the only way to get a value in here.
 */
const ownImagePath = z
  .string()
  .trim()
  .max(300)
  .refine((value) => !value || /^\/uploads\/blog\/[A-Za-z0-9._-]+$/.test(value), {
    message: "Upload the image first — external image URLs are not accepted",
  });

const faq = z.object({
  q: z.string().trim().min(1, "The question cannot be empty").max(LIMITS.BLOG_FAQ_Q_MAX),
  a: z.string().trim().min(1, "The answer cannot be empty").max(LIMITS.BLOG_FAQ_A_MAX),
});

/**
 * The editable surface of a post.
 *
 * `contentHtml` is capped but otherwise unexamined here: judging HTML is
 * `utils/sanitizeHtml`'s job, and a zod refinement that tried would be a second,
 * weaker implementation of the same rules — the classic way a sanitiser gets
 * bypassed is two of them disagreeing about what the input was.
 */
const postFields = {
  title: z.string().trim().min(1, "Give the post a title").max(LIMITS.BLOG_TITLE_MAX),
  slug: slug.optional(),
  metaTitle: z.string().trim().max(LIMITS.BLOG_META_TITLE_MAX).default(""),
  metaDescription: z.string().trim().max(LIMITS.BLOG_META_DESC_MAX).default(""),
  excerpt: z.string().trim().max(LIMITS.BLOG_EXCERPT_MAX).default(""),
  contentHtml: z
    .string()
    .max(LIMITS.BLOG_CONTENT_MAX, "This post is too long to save. Split it into two.")
    .default(""),
  coverImage: ownImagePath.default(""),
  coverImageAlt: z.string().trim().max(300).default(""),
  tags: z
    .array(z.string().trim().min(1).max(LIMITS.BLOG_TAG_MAX))
    .max(LIMITS.BLOG_MAX_TAGS, `At most ${LIMITS.BLOG_MAX_TAGS} tags`)
    .default([]),
  focusKeyword: z.string().trim().max(120).default(""),
  faqs: z.array(faq).max(LIMITS.BLOG_MAX_FAQS).default([]),
  canonicalUrl: absoluteUrl.default(""),
  noindex: z.boolean().default(false),
  authorName: z.string().trim().max(120).default(""),
};

const createPostSchema = z.object(postFields);

/**
 * Every field optional, and `.partial()` rather than a second literal object, so
 * a field added above cannot be forgotten here — the drift that shows up as "the
 * editor saves it and the API silently drops it".
 */
const updatePostSchema = z.object(postFields).partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Nothing to update" }
);

/** Publishing takes no body — what is being published is already stored. */
const publishSchema = z.object({}).passthrough().optional();

const uploadImageSchema = z.object({
  /**
   * A data URL. The same transport the receipt scanner uses, and for the same
   * reason: it needs no multipart parser and no new dependency, and the editor
   * already holds the file as one after a paste or a drag.
   *
   * Only the prefix is checked here. The MIME type, the extension and the size
   * are decided by `utils/blogStorage`, which is the single place that maps a
   * declared type to a filename on disk.
   */
  image: z
    .string()
    .min(1, "No image was sent")
    .refine((value) => value.startsWith("data:image/"), {
      message: "That is not an image",
    }),
});

const slugParams = z.object({ slug: z.string().trim().min(1).max(LIMITS.BLOG_SLUG_MAX + 20) });

const idParams = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, "Not a valid post id"),
});

/**
 * The public listing.
 *
 * `page` rather than a cursor: a blog index is a small, ordered, publicly
 * enumerable list where "page 3" is a URL people link to and crawlers follow.
 * The stability problems that make cursors right for a live feed do not apply to
 * a set that changes once a day.
 */
const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(LIMITS.MAX_PAGE_SIZE).default(LIMITS.BLOG_PAGE_SIZE),
  tag: z.string().trim().toLowerCase().max(LIMITS.BLOG_TAG_MAX).optional(),
});

/** The admin listing, which can also see drafts and search. */
const adminListQuery = listQuery.extend({
  status: z.enum([BLOG_STATUS.DRAFT, BLOG_STATUS.PUBLISHED]).optional(),
  q: z.string().trim().max(200).optional(),
});

module.exports = {
  createPostSchema,
  updatePostSchema,
  publishSchema,
  uploadImageSchema,
  slugParams,
  idParams,
  listQuery,
  adminListQuery,
  slugify,
};
