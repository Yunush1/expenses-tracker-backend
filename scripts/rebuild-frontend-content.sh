#!/bin/bash
#
# Rebuild and republish the static site for a CONTENT change.
#
# Called by scripts/deploy-hook-server.js when a blog post is published. It is
# deliberately NOT deploy-frontend.sh, and the difference is the point.
#
# ## Why publishing a blog post must not run the code deploy
#
# deploy-frontend.sh begins with `git pull` and `npm install`. That is correct for
# a code deploy and dangerous as a publish trigger: an author clicking "publish"
# in the admin panel would ship whatever happens to be on the remote branch —
# someone else's half-finished commit, a dependency bumped an hour ago — to
# production, with no one intending a deploy and no one watching the output.
#
# A blog post is content. The code that renders it is whatever is already checked
# out and already live. So this script builds the working tree as it stands and
# touches nothing else.
#
# ## Why the publish step is not `rm -rf` + `cp`
#
# deploy-frontend.sh empties $DEPLOY_DIR and then copies into it. Between those
# two commands nginx is serving an empty directory, and every visitor in that
# window — several seconds for a tree this size — gets a 404. That is an
# acceptable trade on a deploy someone chose to run at a quiet hour. It is not
# acceptable several times a week at whatever moment an author finishes writing.
#
# rsync replaces files individually and deletes only what is gone, so the site
# stays served throughout. Vite's asset filenames are content-hashed, so the new
# index.html and the assets it names are never in conflict with the old ones.
#
# For a genuinely atomic cutover, point nginx's root at a `current` symlink and
# swing it — see the note at the bottom of this file.

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/expencses/expenses-tracker-frontend}"
DEPLOY_DIR="${DEPLOY_DIR:-/var/www/expenses}"

cd "$PROJECT_DIR"

echo "Building $(git rev-parse --short HEAD 2>/dev/null || echo 'working tree') — content rebuild, no pull"

# The build fetches published posts from VITE_API_BASE_URL (build/blogFeed.js). If
# the API is unreachable it warns and ships the site WITHOUT pre-rendered posts
# rather than failing, so a zero exit here does not by itself mean the new post is
# in the output. That warning is in this log — the deploy hook records it.
npm run build

if [ ! -f dist/index.html ]; then
  echo "ERROR: the build produced no dist/index.html. Refusing to publish." >&2
  exit 1
fi

# The specific file that makes this worth doing at all. Its absence means the
# build could not reach the API and the post is still uncrawlable, which is a
# failure of the whole exercise even though the build succeeded.
if [ ! -f dist/blog/index.html ]; then
  echo "WARNING: no dist/blog/index.html — the build did not get the post archive." >&2
  echo "WARNING: check VITE_API_BASE_URL and that the API is up." >&2
fi

mkdir -p "$DEPLOY_DIR"

# Checked rather than assumed: without rsync the only way to finish is the
# rm -rf + cp this script exists to avoid, and doing that silently would reinstate
# the outage window while the log still said everything went fine.
# --chown needs rsync >= 3.1 (Ubuntu 16.04 and later ship 3.1+).
if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync is not installed. Install it (apt install rsync) — the fallback" >&2
  echo "ERROR: would empty the live directory before repopulating it." >&2
  exit 1
fi

# --delete so a post that was unpublished stops being served as a stale file.
# Trailing slash on the source is load-bearing: without it rsync creates
# $DEPLOY_DIR/dist/ instead of copying the contents.
rsync -a --delete \
  --chown=www-data:www-data \
  --chmod=D755,F644 \
  dist/ "$DEPLOY_DIR/"

# No `systemctl reload nginx`. nginx does not cache static files across requests
# by default, and reloading it on every blog post is a privileged operation run
# for no reason. If open_file_cache is enabled in the config, that is the thing to
# adjust — a reload is treating the symptom.
echo "Published to $DEPLOY_DIR"

# ── The atomic version, if you want it ───────────────────────────────────────
#
# rsync narrows the window; it does not close it. To close it, make nginx's root
# a symlink and swing it — rename(2) over an existing symlink is atomic, so the
# site is one release or the other and never halfway between:
#
#   mkdir -p /var/www/expenses-releases
#   mv /var/www/expenses /var/www/expenses-releases/initial
#   ln -s /var/www/expenses-releases/initial /var/www/expenses
#
# then replace the rsync above with a copy into a new release directory and
#
#   ln -sfn "$RELEASE" /var/www/expenses.tmp && mv -T /var/www/expenses.tmp /var/www/expenses
#
# `mv -T` is the rename; `ln -sfn` alone would follow the existing symlink and
# create the new link *inside* the release directory instead of replacing it.
#
# One nginx caveat before doing this: if the config sets `open_file_cache`, nginx
# will keep serving file handles from the old release until those entries expire.
# Either leave it off or accept the cache duration as the cutover lag.
