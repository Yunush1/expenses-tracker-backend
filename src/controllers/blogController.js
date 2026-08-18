const asyncHandler = require("../middlewares/asyncHandler");
const blogService = require("../services/blogService");
const deployHookService = require("../services/deployHookService");
const blogStorage = require("../utils/blogStorage");
const { ok, created } = require("../utils/apiResponse");
const {
  toCardDTO,
  toPublicPostDTO,
  toAdminPostDTO,
  toAdminCardDTO,
  toRenderDTO,
} = require("../serializers/blogSerializer");

/**
 * Blog endpoints (docs/23-BLOG.md §7).
 *
 * Thin, like every controller here. The one thing worth reading twice is which
 * serializer each handler reaches for: the public handlers use
 * `toPublicPostDTO`/`toCardDTO` and the admin ones use the `Admin` variants. That
 * choice is the last line of defence on what a reader can see, and it is made
 * once per handler rather than by a flag — see serializers/blogSerializer.js.
 */

/* -------------------------------- Public -------------------------------- */

exports.listPosts = asyncHandler(async (req, res) => {
  const { page, limit, tag } = req.validatedQuery;
  const { items, total } = await blogService.listPublished({ page, limit, tag });

  return ok(res, {
    posts: items.map(toCardDTO),
    page,
    limit,
    total,
    // Sent rather than left to the client to derive, because the pagination links
    // are crawlable URLs and an off-by-one produces a page of nothing that a
    // search engine will index as thin content.
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

exports.listTags = asyncHandler(async (req, res) => ok(res, await blogService.listTags()));

/**
 * One article.
 *
 * ## Why a renamed post answers 301 rather than 404
 *
 * The old URL is in search results and in other people's links. A 404 discards
 * every bit of ranking the page earned and shows a reader an error for a link
 * that was correct when it was written. A **permanent** redirect is the one
 * response that transfers that ranking to the new address — 302 explicitly does
 * not, and tells search engines to keep indexing the old URL.
 *
 * Answered as a payload rather than an HTTP redirect because the caller is a
 * client-side router, not a browser following a Location header: this is a JSON
 * API, and a 301 on `/api/blog/old-slug` would move the *API* request, leaving
 * the address bar on the dead URL. The client performs the real redirect.
 */
exports.getPost = asyncHandler(async (req, res) => {
  const { post, redirectTo } = await blogService.getPublishedBySlug(req.params.slug);

  if (redirectTo) return ok(res, { redirectTo });

  const related = await blogService.getRelated(post);
  return ok(res, toPublicPostDTO(post, related));
});

/**
 * The whole published archive, flat.
 *
 * Read by the frontend build (`build/seoPlugin.js`) to pre-render a static page
 * per post, and by nothing else. Public and unauthenticated on purpose: it
 * returns exactly what `/blog/<slug>` already returns for each post, so there is
 * nothing here that was not already published — and requiring a credential would
 * mean putting one in CI to build a site made of public pages.
 *
 * Unpaginated, deliberately. A sitemap that stops at page one hides the rest of
 * the site, and a build that renders the first twelve posts silently drops the
 * thirteenth out of the index.
 */
exports.listForRender = asyncHandler(async (req, res) => {
  const posts = await blogService.listForRender();
  return ok(res, posts.map(toRenderDTO));
});

/* -------------------------------- Admin --------------------------------- */

exports.adminList = asyncHandler(async (req, res) => {
  const { page, limit, status, q } = req.validatedQuery;
  const { items, total } = await blogService.listAll({ page, limit, status, q });

  return ok(res, {
    posts: items.map(toAdminCardDTO),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    /**
     * Whether publishing will actually rebuild the site.
     *
     * Surfaced in the list rather than only at the publish button so the gap is
     * visible before it costs anything: without a hook the posts are live in the
     * API and absent from every crawler, which is the failure this whole feature
     * exists to avoid and the one an author would never think to check for.
     */
    deployHookConfigured: deployHookService.isConfigured(),
  });
});

exports.adminGet = asyncHandler(async (req, res) => {
  const post = await blogService.getPostForAdmin(req.params.id);
  return ok(res, { ...toAdminPostDTO(post), issues: blogService.readinessIssues(post) });
});

exports.createPost = asyncHandler(async (req, res) => {
  const post = await blogService.createPost(req.body, req.user);
  return created(res, { ...toAdminPostDTO(post), issues: blogService.readinessIssues(post) });
});

exports.updatePost = asyncHandler(async (req, res) => {
  const { post, deploy } = await blogService.updatePost(req.params.id, req.body);

  return ok(res, {
    ...toAdminPostDTO(post),
    issues: blogService.readinessIssues(post),
    deploy,
  });
});

/**
 * Publish, and say what happened to the rebuild.
 *
 * `deploy` and `issues` both ride along on success. The post is live either way
 * — neither a failed hook nor an unmet checklist blocks it — and the author is
 * told rather than stopped, because an editor that refuses to publish a short
 * announcement is an editor people work around.
 */
exports.publishPost = asyncHandler(async (req, res) => {
  const { post, deploy, issues } = await blogService.publishPost(req.params.id);
  return ok(res, { ...toAdminPostDTO(post), deploy, issues });
});

exports.unpublishPost = asyncHandler(async (req, res) => {
  const { post, deploy } = await blogService.unpublishPost(req.params.id);
  return ok(res, { ...toAdminPostDTO(post), deploy });
});

exports.deletePost = asyncHandler(async (req, res) => {
  const { deploy } = await blogService.deletePost(req.params.id);
  return ok(res, { deleted: true, deploy });
});

/**
 * Store an image and hand back its URL.
 *
 * The response shape is `{ location }` because that is what TinyMCE's
 * `images_upload_handler` resolves with — matching it here means the editor
 * needs no adapter, and the one place the two could drift is this comment.
 */
exports.uploadImage = asyncHandler(async (req, res) => {
  const location = await blogStorage.save(req.body.image);
  return created(res, { location });
});

/**
 * Rebuild the static site by hand.
 *
 * Exists because the automatic trigger can fail — a hook that timed out, a
 * deploy that was cancelled, a post published while the URL was misconfigured —
 * and the alternative to a button is an operator who has to find the Netlify
 * dashboard to make yesterday's post crawlable.
 */
exports.triggerDeploy = asyncHandler(async (req, res) => {
  const deploy = await deployHookService.trigger("manual rebuild from the admin panel");
  return ok(res, deploy);
});
