#!/usr/bin/env bash
# corkboard-bin at a published release: pkgver, the checksums of what it
# downloads (the tarballs' from GitHub's digests of them), and .SRCINFO,
# without needing makepkg.
#
#   packaging/aur/update.sh 0.1.1
#   packaging/aur/update.sh 0.1.1-rc1     pkgver 0.1.1rc1, which pacman puts before 0.1.1
#
# Then, in a clone of ssh://aur@aur.archlinux.org/corkboard-bin.git, copy
# PKGBUILD, .SRCINFO and corkboard.desktop in, commit and push.
set -euo pipefail
version=${1:?version, e.g. 0.1.1}
pkgver=${version//-/}
dir=$(cd "$(dirname "$0")/corkboard-bin" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

release=https://github.com/mattjurenka/corkboard/releases/download/v$version
sum() { curl -fsSL "$1" -o "$tmp/f" && sha256sum "$tmp/f" | cut -d' ' -f1; }
digest() { gh api "repos/mattjurenka/corkboard/releases/tags/v$version" -q ".assets[] | select(.name == \"$1\") | .digest" | sed 's/^sha256://'; }
desktop=$(sha256sum "$dir/corkboard.desktop" | cut -d' ' -f1)
icon=$(sum "https://raw.githubusercontent.com/mattjurenka/corkboard/v$version/app/build/icons/512x512.png")
x64=$(digest "corkboard-$version-linux-x64.tar.gz")
arm64=$(digest "corkboard-$version-linux-arm64.tar.gz")
[ -n "$x64" ] && [ -n "$arm64" ] || { echo "v$version has no Linux tarballs" >&2; exit 1; }

sed -i \
  -e "s/^_version=.*/_version=$version/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^sha256sums=('[^']*'/sha256sums=('$desktop'/" \
  -e "s/^            '[0-9a-fSKIP]*')$/            '$icon')/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$x64')/" \
  -e "s/^sha256sums_aarch64=.*/sha256sums_aarch64=('$arm64')/" \
  "$dir/PKGBUILD"

cat > "$dir/.SRCINFO" <<EOF
pkgbase = corkboard-bin
	pkgdesc = Neovim with Claude Code agents beside it
	pkgver = $pkgver
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
	source = corkboard-$pkgver.png::https://raw.githubusercontent.com/mattjurenka/corkboard/v$version/app/build/icons/512x512.png
	sha256sums = $desktop
	sha256sums = $icon
	source_x86_64 = $release/corkboard-$version-linux-x64.tar.gz
	sha256sums_x86_64 = $x64
	source_aarch64 = $release/corkboard-$version-linux-arm64.tar.gz
	sha256sums_aarch64 = $arm64

pkgname = corkboard-bin
EOF
echo "corkboard-bin $pkgver"
