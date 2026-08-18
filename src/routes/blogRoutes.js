const express = require("express");

const blogController = require("../controllers/blogController");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const {
  createPostSchema,
  updatePostSchema,
  uploadImageSchema,
  slugParams,
  idParams,
  listQuery,
  adminListQuery,
} = require("../validators/blogValidators");

const router = express.Router();

/**
 * The blog (docs/23-BLOG.md).
 *
 * ## The one rule in this file
 *
 * **Everything under `/admin` is `requireAuth` then `requireAdmin`, in that
 * order, and nothing else is.** The split is by path prefix rather than by verb,
 * which is the opposite of `sheetRoutes` and deliberately so: a sheet's writes
 * are performed by ordinary users and its reads are conditional, whereas here
 * there is exactly one class of writer and the public half is entirely read-only.
 * A prefix that maps one-to-one onto a trust level is the version of this that
 * cannot be got subtly wrong.
 *
 * The two middlewares are not interchangeable and the order is not cosmetic:
 * `requireAuth` establishes *who* the caller is from a verified Firebase token,
 * and `requireAdmin` decides whether that identity is on the operator allowlist.
 * `requireAdmin` alone would read `req.user` off a request where nothing had set
 * it and let everyone through — it has no way to establish an identity itself,
 * and says so at the top of its own file.
 *
 * ## Why the allowlist is an environment variable and not a role on the user
 *
 * `ADMIN_EMAILS` is comma-separated and compared case-insensitively, so adding a
 * second author is one variable and a restart — no migration, no admin-managing-
 * admins screen, and no frontend deploy. It fails closed twice: an empty list
 * forbids everyone, and a token carrying no email is refused rather than waved
 * through.
 *
 * The browser is told nothing about who qualifies. There is no allowlist in the
 * bundle and no email comparison in React; the admin screens simply call these
 * endpoints and render what comes back, so a 403 *is* the gate. A client-side
 * check would ship the rule to everyone and still leave the endpoint answering
 * anyone who called it directly.
 */

/* -------------------------------- Public -------------------------------- */

/**
 * Declared before "/:slug" so these literal segments are not swallowed by the
 * parameter — the same ordering hazard the ledger and sheet routers call out.
 */

/** The index. Crawlable, paginated, published posts only. */
router.get("/", validate(listQuery, "query"), blogController.listPosts);

router.get("/tags", blogController.listTags);

/**
 * The whole published archive, for the frontend build's pre-renderer.
 *
 * Public and unauthenticated: it returns only what `/blog/<slug>` already
 * returns for each post. Requiring a token would mean holding a credential in CI
 * to build a site made of public pages — a secret to protect nothing.
 */
router.get("/render-feed", blogController.listForRender);

/* --------------------------------- Admin -------------------------------- */

/**
 * Mounted before "/:slug" for the routing reason above, and grouped here so the
 * gate is visible as one block rather than repeated down the file.
 *
 * `router.use` rather than per-route middleware: a new admin endpoint added
 * below this line is protected by default, whereas a per-route list is protected
 * only if whoever adds it remembers. The failure directions are not symmetric —
 * a forgotten gate here hands an anonymous caller the ability to publish to the
 * site's front page.
 */
router.use("/admin", requireAuth, requireAdmin);

router.get("/admin/posts", validate(adminListQuery, "query"), blogController.adminList);

router.post(
  "/admin/posts",
  writeLimiter,
  validate(createPostSchema),
  blogController.createPost
);

router.get("/admin/posts/:id", validate(idParams, "params"), blogController.adminGet);

/**
 * Deliberately not behind `writeLimiter`.
 *
 * This is the editor's save, and an author working through a long post saves far
 * more often than the shared write limiter's 120-per-15-minutes allows — being
 * locked out of your own draft mid-sentence is the same failure the sheet's
 * per-cell save documents.
 *
 * What still bounds it: `globalLimiter`, a verified token, the operator
 * allowlist, and a body cap. The set of people who can reach this is the set of
 * people who could deploy the site anyway.
 */
router.patch(
  "/admin/posts/:id",
  validate(idParams, "params"),
  validate(updatePostSchema),
  blogController.updatePost
);

router.delete("/admin/posts/:id", validate(idParams, "params"), blogController.deletePost);

router.post(
  "/admin/posts/:id/publish",
  writeLimiter,
  validate(idParams, "params"),
  blogController.publishPost
);

router.post(
  "/admin/posts/:id/unpublish",
  writeLimiter,
  validate(idParams, "params"),
  blogController.unpublishPost
);

/**
 * Image upload. Rate-limited, unlike the save above, because each call writes a
 * file to disk that is never swept — the one admin operation with an unbounded
 * footprint.
 */
router.post(
  "/admin/images",
  writeLimiter,
  validate(uploadImageSchema),
  blogController.uploadImage
);

/** Rebuild the static site by hand, for when the automatic trigger did not fire. */
router.post("/admin/deploy", writeLimiter, blogController.triggerDeploy);

/**
 * One article, by slug. **Last**, because it matches anything — declaring it
 * above would make `/blog/tags` a request for a post called "tags".
 */
router.get("/:slug", validate(slugParams, "params"), blogController.getPost);

module.exports = router;
