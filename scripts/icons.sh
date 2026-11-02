#!/usr/bin/env bash
# The app's icons (app/build/), from web/public/logo.svg, for electron-builder:
#
#   nix shell nixpkgs#librsvg nixpkgs#imagemagick nixpkgs#libicns -c scripts/icons.sh
#
# icon.png and icons/<n>x<n>.png for Linux, icon.ico for Windows, and
# icon.icns for macOS, whose icons sit inside a margin of their own (824 of
# 1024, as Apple's grid has it). The results are committed.
set -euo pipefail
cd "$(dirname "$0")/.."
out=app/build
svg=web/public/logo.svg
mkdir -p "$out/icons"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

rsvg-convert -w 1024 -h 1024 "$svg" -o "$out/icon.png"
for n in 16 24 32 48 64 128 256 512 1024; do
  rsvg-convert -w "$n" -h "$n" "$svg" -o "$out/icons/${n}x${n}.png"
done
magick "$out/icons/16x16.png" "$out/icons/24x24.png" "$out/icons/32x32.png" "$out/icons/48x48.png" \
  "$out/icons/64x64.png" "$out/icons/128x128.png" "$out/icons/256x256.png" "$out/icon.ico"

rsvg-convert -w 824 -h 824 "$svg" -o "$tmp/inner.png"
magick "$tmp/inner.png" -background none -gravity center -extent 1024x1024 "$tmp/mac.png"
for n in 16 32 128 256 512; do magick "$tmp/mac.png" -resize "${n}x${n}" "$tmp/mac_$n.png"; done
png2icns "$out/icon.icns" "$tmp"/mac_{16,32,128,256,512}.png "$tmp/mac.png" >/dev/null
