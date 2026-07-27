#!/usr/bin/env bash
#
# package.sh — build a clean Chrome Web Store upload ZIP from dist/.
#
# The extension ships as the *built* dist/ tree, never the repo root, so the
# usual "zip the project and exclude dev files" recipe is wrong here: it would
# bundle src/, node_modules/, docs/ and the .git history. We rebuild from
# scratch, sanity-check the artifacts a reviewer will look at, then zip the
# inside of dist/ so manifest.json lands at the archive root (Chrome rejects a
# ZIP whose manifest sits one directory down).
#
# Usage: npm run package

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./public/manifest.json').version")
PKG_VERSION=$(node -p "require('./package.json').version")
OUTPUT="lychee-ai-v${VERSION}.zip"

if [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "✗ version mismatch: manifest.json is $VERSION, package.json is $PKG_VERSION" >&2
  echo "  Bump both together — the store reads the manifest, humans read the package." >&2
  exit 1
fi

echo "→ Building Lychee AI v${VERSION} (typecheck + panel build + sandbox build)"
npm run build

# Files a reviewer will open first. A missing one fails the upload or the review,
# so catch it here rather than in the dashboard.
for f in manifest.json sidepanel.html sidepanel.js background.js offscreen.html \
         offscreen.js sandbox.html sandbox-exec.html sandbox-exec.js \
         icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png; do
  [ -f "dist/$f" ] || { echo "✗ dist/$f is missing — build is incomplete" >&2; exit 1; }
done

# Source maps and Finder droppings must never ship: maps bloat the package and
# .DS_Store files show up as unexplained binaries in review.
find dist -name '*.map' -delete
find dist -name '.DS_Store' -delete

rm -f "$OUTPUT"
(cd dist && zip -qr "../$OUTPUT" . -x '.*' -x '__MACOSX/*')

echo "✓ $OUTPUT ($(du -h "$OUTPUT" | cut -f1), $(unzip -l "$OUTPUT" | tail -1 | awk '{print $2}') files)"
echo "  Upload at https://chrome.google.com/webstore/devconsole"
