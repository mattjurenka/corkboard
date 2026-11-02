#!/usr/bin/env bash
# corkboard-bin at a published release: pkgver, the checksums of what it
# downloads, and .SRCINFO, without needing makepkg.
#
#   packaging/aur/update.sh 0.1.1
#
# Then, in a clone of ssh://aur@aur.archlinux.org/corkboard-bin.git, copy
# PKGBUILD, .SRCINFO and corkboard.desktop in, commit and push.
set -euo pipefail
version=${1:?version, e.g. 0.1.1}
dir=$(cd "$(dirname "$0")/corkboard-bin" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

release=https://github.com/mattjurenka/corkboard/releases/download/v$version
sum() { curl -fsSL "$1" -o "$tmp/f" && sha256sum "$tmp/f" | cut -d' ' -f1; }
desktop=$(sha256sum "$dir/corkboard.desktop" | cut -d' ' -f1)
icon=$(sum "https://raw.githubusercontent.com/mattjurenka/corkboard/v$version/app/build/icons/512x512.png")
x64=$(sum "$release/corkboard-$version-linux-x64.tar.gz")
arm64=$(sum "$release/corkboard-$version-linux-arm64.tar.gz")

sed -i \
  -e "s/^pkgver=.*/pkgver=$version/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^sha256sums=('[^']*'/sha256sums=('$desktop'/" \
  -e "s/^            '[0-9a-fSKIP]*')$/            '$icon')/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$x64')/" \
  -e "s/^sha256sums_aarch64=.*/sha256sums_aarch64=('$arm64')/" \
  "$dir/PKGBUILD"

cat > "$dir/.SRCINFO" <<EOF
pkgbase = corkboard-bin
	pkgdesc = Neovim with Claude Code agents beside it
	pkgver = $version
	pkgrel = 1
	url = https://corkboard.fyi
	arch = x86_64
	arch = aarch64
	license = AGPL-3.0-only
	depends = git
	depends = claude-code
	depends = ripgrep
	depends = fd
	depends = gtk3
	depends = nss
	depends = alsa-lib
	depends = libxss
	depends = libxtst
	depends = libsecret
	depends = xdg-utils
	provides = corkboard
	conflicts = corkboard
	options = !strip
	options = !debug
	source = corkboard.desktop
	source = corkboard-$version.png::https://raw.githubusercontent.com/mattjurenka/corkboard/v$version/app/build/icons/512x512.png
	sha256sums = $desktop
	sha256sums = $icon
	source_x86_64 = $release/corkboard-$version-linux-x64.tar.gz
	sha256sums_x86_64 = $x64
	source_aarch64 = $release/corkboard-$version-linux-arm64.tar.gz
	sha256sums_aarch64 = $arm64

pkgname = corkboard-bin
EOF
echo "corkboard-bin $version"
