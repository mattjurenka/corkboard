#!/usr/bin/env bash
# The corkboard cask at a published release: its version and the dmgs'
# checksums, from GitHub's digests of them.
#
#   packaging/homebrew/update.sh 0.1.1
#
# Then, in a clone of github.com/mattjurenka/homebrew-tap, copy Casks/ in,
# commit and push; it's `brew install --cask mattjurenka/tap/corkboard`.
set -euo pipefail
version=${1:?version, e.g. 0.1.1}
cask=$(cd "$(dirname "$0")" && pwd)/Casks/corkboard.rb

digest() { gh api "repos/mattjurenka/corkboard/releases/tags/v$version" -q ".assets[] | select(.name == \"$1\") | .digest" | sed 's/^sha256://'; }
arm64=$(digest "corkboard-$version-mac-arm64.dmg")
x64=$(digest "corkboard-$version-mac-x64.dmg")
[ -n "$arm64" ] && [ -n "$x64" ] || { echo "v$version has no Mac dmgs" >&2; exit 1; }

sed -i \
  -e "s/^  version \".*\"/  version \"$version\"/" \
  -e "s/^  sha256 arm:   \".*\",/  sha256 arm:   \"$arm64\",/" \
  -e "s/^         intel: \".*\"/         intel: \"$x64\"/" \
  "$cask"
echo "corkboard $version"
