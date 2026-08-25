const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const config = require("../config/env");
const logger = require("./logger");

/**
 * Where an image dropped into the blog editor is kept.
 *
 * A near-twin of `receiptStorage`, and deliberately a separate file rather than a
 * parameter on that one, because the two have opposite retention rules and
 * opposite exposure. A receipt is private-by-obscurity and swept after a couple
 * of days; a blog image is **published on purpose**, indexed by Google Images,
 * hotlinked from other sites, and must never be deleted while a post references
 * it. Folding them together would put a sweep job one config change away from
 * deleting the illustrations out of every published article.
 *
 * ## The filename is not a credential here
 *
 * That is the other inversion. Receipts use 128 random bits because the name is
 * the only thing standing between a stranger and someone's till slip. Nothing
 * about a blog image is secret — it is going in an `<img>` tag on a public page.
 * The random name is kept anyway, for two reasons that have nothing to do with
 * secrecy: it makes the file a content address, so it can be cached for a year
 * without a cache-busting query string; and it means two uploads called
 * `screenshot.png` cannot overwrite each other.
 *
 * ## Why the extension is decided here and not by the uploader
 *
 * Same rule as receipts, and it matters more: this directory is served as static
 * files from a domain, so a caller who could choose the extension could write
 * `.html` and get a same-origin document. The MIME type is matched against a
 * fixed table, the extension comes from that table, and the name is generated —
 * nothing an uploader sends becomes part of a path.
 */

const EXTENSIONS = Object.freeze({
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  /**
   * Allowed here and not for receipts, because a blog needs diagrams and a
   * receipt never does. SVG is **not** on this list and must not be added: it is
   * an executable document — a script inside one runs with the origin of
   * whatever page embeds it, and served from this directory that is the site's
   * own origin.
   */
  "image/gif": "gif",
  "image/avif": "avif",
});

const DATA_URL = /^data:(image\/(?:jpeg|jpg|png|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/;

/** Absolute path to the directory files are written into. */
const storageDir = () => path.resolve(process.cwd(), config.blog.imageDir);

/** The URL path they are served from, e.g. `/uploads/blog`. */
const URL_PREFIX = "/uploads/blog";

const isEnabled = () => config.blog.imagesEnabled;

/**
 * Write a data URL to disk and return its public URL.
 *
 * **Throws**, unlike its receipt counterpart, and that difference is the point.
 * A receipt photo is a nicety attached to a scan that has already succeeded, so
 * losing it silently is correct. Here the upload *is* the operation: an author
 * who drops an image into the editor and gets back a silent null ends up with a
 * broken `<img>` in a published article, discovered by a reader. Fail loudly and
 * let the editor say so.
 */
const save = async (dataUrl) => {
  if (!isEnabled()) {
    throw new Error("Blog image uploads are disabled on this server");
  }

  const match = DATA_URL.exec(String(dataUrl || ""));
  if (!match) {
    throw new Error("Unsupported image. Use JPEG, PNG, WebP, GIF or AVIF.");
  }

  const [, mime, base64] = match;
  const extension = EXTENSIONS[mime];
  if (!extension) throw new Error("Unsupported image type");
  logger.info(`[BlogStorage] Unsupported image type: ${mime}`)
  const bytes = Buffer.from(base64.replace(/\s/g, ""), "base64");

  /**
   * Checked after decoding, not against the base64 length.
   *
   * Base64 inflates by a third, so a limit applied to the encoded string is a
   * limit roughly 25% tighter than whatever number is in the config — the kind
   * of discrepancy that surfaces as "it rejects my 4MB image and the docs say
   * 5MB".
   */
  if (bytes.length > config.blog.maxImageBytes) {
    const mb = (config.blog.maxImageBytes / (1024 * 1024)).toFixed(1);
    logger.info(`[BlogStorage] That image is tool large ${mb}`)
    throw new Error(`That image is too large. The limit is ${mb} MB.`);
  }

  const dir = storageDir();
  await fs.mkdir(dir, { recursive: true });

  const name = `${crypto.randomBytes(16).toString("hex")}.${extension}`;
  await fs.writeFile(path.join(dir, name), bytes);

  logger.info(`[blog] Stored image ${name} (${Math.round(bytes.length / 1024)}kb)`);

  return `${URL_PREFIX}/${name}`;
};

/**
 * Whether a URL is one this server produced.
 *
 * Used before a value is written into a post's `coverImage`, which the frontend
 * resolves against the API origin and renders without further thought. Without
 * this, a cover image could be pointed at any host on the internet — turning
 * every published article into a beacon for whoever controls that host, and
 * handing them the referrer and IP of every reader.
 *
 * A prefix test on the *path*, after parsing, so `/uploads/blog/../../etc` and
 * `https://evil.com/uploads/blog/x.png` both fail.
 */
const isOwnUrl = (url) => {
  const value = String(url || "").trim();
  if (!value) return false;

  // Relative is the only shape this server emits. Anything absolute is foreign
  // by definition, including a URL pointing back at this same host — which the
  // server cannot verify anyway, since it does not reliably know its own origin.
  if (!value.startsWith("/")) return false;

  // Normalise away any traversal before comparing.
  const normalised = path.posix.normalize(value.split("?")[0].split("#")[0]);
  return normalised.startsWith(`${URL_PREFIX}/`) && normalised.length > URL_PREFIX.length + 1;
};

module.exports = { save, storageDir, URL_PREFIX, isEnabled, isOwnUrl };
