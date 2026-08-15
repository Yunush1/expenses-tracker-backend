const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config/env");
const logger = require("./logger");

/**
 * Where a scanned receipt photo is kept.
 *
 * ## The photo is served without a login, and the filename is what protects it
 *
 * A receipt is a photograph of a place someone was, at a time, with a card
 * (docs/10-AI-ASSISTANT.md §8). It is served from a static directory with no
 * session and no membership check, because every member of a group — most of whom
 * have no account at all — has to be able to see it.
 *
 * So the *name* is the credential. 32 hex characters from `crypto.randomBytes` is
 * 128 bits: the same capability-URL model the invite link already uses
 * (docs/02-HLD.md §3.4), and the same guarantee — unguessable in practice, and
 * therefore worthless to enumerate. Sequential names, or anything derived from a
 * group or member id, would turn the directory into a browsable archive of other
 * people's receipts, which is the one outcome this file exists to prevent.
 *
 * What that model does *not* protect against, stated plainly: anybody who is given
 * the URL can open it, forever, whether or not they are still in the group. That
 * is the same trade the invite link makes, and it is the reason `noindex` and the
 * retention sweep below both exist.
 *
 * ## Why the extension is decided here and not by the uploader
 *
 * The client sends a data URL, and its declared MIME type is untrusted input that
 * ends up as a filename on disk. Only three types are accepted, each mapped to a
 * fixed extension, so nothing a caller writes can produce `.html`, `.js`, a path
 * separator or a traversal sequence. The name is generated, never taken.
 */

const EXTENSIONS = Object.freeze({
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});

const DATA_URL = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/** Absolute path to the directory files are written into. */
const storageDir = () => path.resolve(process.cwd(), config.receipts.dir);

/** The URL path they are served from, e.g. `/uploads/receipts`. */
const URL_PREFIX = "/uploads/receipts";

const isEnabled = () => config.receipts.enabled;

/**
 * Write a data URL to disk and return its public URL, or null.
 *
 * Never throws. Storing the photograph is a convenience laid on top of reading it,
 * and a full disk or a bad permission must not turn a successful scan — which has
 * already been paid for — into an error. The scan's *result* is the valuable part;
 * the file is a nicety, and losing it silently is the right failure.
 */
const save = async (dataUrl) => {
  if (!isEnabled()) return null;

  const match = DATA_URL.exec(String(dataUrl || ""));
  if (!match) return null;

  const [, mime, base64] = match;
  const extension = EXTENSIONS[mime];
  if (!extension) return null;

  try {
    const dir = storageDir();
    await fs.mkdir(dir, { recursive: true });

    // 128 bits of name. See the note at the top — this is the access control.
    const name = `${crypto.randomBytes(16).toString("hex")}.${extension}`;

    await fs.writeFile(path.join(dir, name), Buffer.from(base64.replace(/\s/g, ""), "base64"));

    return `${URL_PREFIX}/${name}`;
  } catch (error) {
    logger.warn(`[receipts] Could not store the photo: ${error.message}`);
    return null;
  }
};

/** `/uploads/receipts/ab12….jpg` → `ab12….jpg`, or null if it is not one of ours. */
const nameFromUrl = (url) => {
  const match = /^\/uploads\/receipts\/([a-f0-9]{32}\.(?:jpg|png|webp))$/.exec(String(url || ""));
  return match ? match[1] : null;
};

/**
 * Delete stored photos that nothing points at any more.
 *
 * Two conditions, and both are needed. **Old enough** — a file written seconds ago
 * belongs to a scan somebody is still reviewing, and deleting it would break the
 * thumbnail in front of them. **Unreferenced** — a photo attached to a real
 * expense is part of that expense and outlives any retention window, because
 * deleting it would silently remove evidence from a record people settle money on.
 *
 * What this actually collects is the common case: a scan taken, looked at, and
 * abandoned without adding anything. Those are invisible to every screen in the
 * app and would otherwise fill a disk quietly, which is the worst way to run out
 * of one.
 *
 * `referenced` is a Set of filenames the caller has looked up. Passing it in
 * rather than querying here keeps this file free of any model import — it knows
 * about bytes and names, and nothing about expenses.
 */
const sweep = async (referenced = new Set(), { olderThanMs = config.receipts.retentionMs } = {}) => {
  if (!isEnabled()) return { deleted: 0, kept: 0 };

  const dir = storageDir();
  let names;

  try {
    names = await fs.readdir(dir);
  } catch {
    // No directory yet means nothing has ever been stored. Not a failure.
    return { deleted: 0, kept: 0 };
  }

  const cutoff = Date.now() - olderThanMs;
  let deleted = 0;
  let kept = 0;

  for (const name of names) {
    if (referenced.has(name)) {
      kept += 1;
      continue;
    }

    try {
      const file = path.join(dir, name);
      // eslint-disable-next-line no-await-in-loop -- a directory of small files, once an hour
      const stat = await fs.stat(file);

      if (stat.mtimeMs > cutoff) {
        kept += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await fs.unlink(file);
      deleted += 1;
    } catch (error) {
      logger.warn(`[receipts] Could not sweep ${name}: ${error.message}`);
    }
  }

  return { deleted, kept };
};

module.exports = { save, sweep, nameFromUrl, storageDir, isEnabled, URL_PREFIX };
