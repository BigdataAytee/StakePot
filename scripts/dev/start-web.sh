#!/usr/bin/env bash
# Run the built web app the way production runs it.
#
# `next start` does not support `output: 'standalone'` — Next says so on every
# boot — so running it that way locally exercises a server the deployment never
# uses. That difference is not academic: `public/` is served automatically by
# `next start` and has to be copied explicitly into a standalone tree, which is
# exactly how `/manifest.json` and `/sw.js` came to 404 in the image while every
# local check passed.
#
# This mirrors apps/web/Dockerfile's runtime stage, so what CI and a developer
# run is what ships.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
web="$here/apps/web"
tree="$web/.next/standalone"

if [ ! -f "$tree/apps/web/server.js" ]; then
  echo "no standalone build — run 'pnpm --filter @stakeam/web build' first" >&2
  exit 1
fi

# Replaced, not merged: `cp -r src dst` when dst already exists nests the copy
# inside it and leaves the previous build's chunks in place, which the browser
# then fails to load with a ChunkLoadError against a hash that no longer exists.
rm -rf "$tree/apps/web/.next/static" "$tree/apps/web/public"
mkdir -p "$tree/apps/web/.next"
cp -r "$web/.next/static" "$tree/apps/web/.next/static"
cp -r "$web/public" "$tree/apps/web/public"

cd "$tree"
exec node apps/web/server.js
