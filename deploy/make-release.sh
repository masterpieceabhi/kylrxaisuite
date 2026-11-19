#!/usr/bin/env bash
# Run on the developer PC. Packs the committed code (only what git tracks: never .env, keys, logs or local data)
# into one file to upload to the server:
#   bash deploy/make-release.sh            -> ../onnhr-releases/onnhr-<commit>.tar.gz
# Uncommitted changes are NOT in the release; it says so if there are any.
set -euo pipefail
cd "$(dirname "$0")/.."
commit="$(git rev-parse --short HEAD)"
out="../onnhr-releases"
mkdir -p "$out"
file="$out/onnhr-$commit.tar.gz"
git archive --format=tar.gz --prefix="onnhr-$commit/" -o "$file" HEAD
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Note: there are uncommitted changes. They are not in this release."
fi
sha="$(sha256sum "$file" | cut -d' ' -f1)"
echo "Release: $(cd "$out" && pwd)/onnhr-$commit.tar.gz"
echo "SHA-256: $sha"
echo "On the server:  sudo bash install-release.sh onnhr-$commit.tar.gz $sha"
