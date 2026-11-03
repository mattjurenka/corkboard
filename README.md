# corkboard

Every agent you're running, pinned to one board.

corkboard is Neovim with Claude Code beside it. Each Claude Code session is a
card on the project's board, and one look tells you which are working, which
are blocked on you, and which are ready for review. Agents claim cards, work
in worktrees of their own, and hand them back for review through corkboard's
MCP server; their terminals, diffs and transcripts are Neovim windows.

## Install

You need [Claude Code](https://claude.com/claude-code), installed and signed
in (`claude` on your PATH), and git. ripgrep and fd make the pickers faster.
Neovim comes with the app.

Downloads are on the [releases page](https://github.com/mattjurenka/corkboard/releases).

| | |
|---|---|
| macOS | `corkboard-<version>-mac-arm64.dmg` (Apple silicon) or `-mac-x64.dmg` (Intel) |
| Windows | `corkboard-<version>-win-x64-setup.exe` |
| Debian, Ubuntu | `sudo apt install ./corkboard-<version>-linux-amd64.deb` |
| Arch | `yay -S corkboard-bin` (AUR) |
| other Linux | `corkboard-<version>-linux-x86_64.AppImage` |
| Nix | `nix run github:mattjurenka/corkboard` (the bridge; open the URL it prints) |

The macOS, Windows and AppImage builds update themselves. On Intel Macs the
avatar has no voice.

## Self-host

Everything here runs without corkboard.fyi: the app, the bridge, the node
(`corkboard-bridge serve`) and the relay its encrypted accounts sync through.
To run your own relay, see [relay/README.md](relay/README.md); then
`corkboard-bridge server <url>` points a machine at it. The hosted
corkboard.fyi (sign-in, spawns, the portal, the phone app) is a separate,
closed service.

## Build from source

With [bun](https://bun.sh) 1.4:

```sh
bun install
bun run dev                 # the bridge on http://127.0.0.1:7777, rebuilding the page per load
bun run app                 # the desktop window onto it (Electron on PATH)
```

The packaged app, for this OS:

```sh
bun install --cwd app
bun run dist                # dist/bridge/<os>-<arch>, then dist/app
```

`scripts/build-bridge.ts` compiles the bridge (`bun build --compile`) and lays
out what it serves beside it, with Neovim's release for that system;
`--target linux-x64,mac-arm64,win-x64,...|all` builds for others.
`scripts/smoke-bridge.ts` tries one. Nix: `nix build .#default` (the bridge)
and `.#app` (the window).

## Releasing

1. Set `version` in `app/package.json`, commit.
2. `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/release.yml` builds every OS and uploads to a draft
   release. Check it, then publish it; the apps update from published
   releases only.
4. AUR: `packaging/aur/update.sh <version>`, then push `PKGBUILD`,
   `.SRCINFO` and `corkboard.desktop` to `aur.archlinux.org/corkboard-bin.git`.

Signing uses the secrets named in `release.yml`; without them the builds are
unsigned (macOS will want right-click, Open; Windows SmartScreen will warn).

## License

AGPL-3.0 ([LICENSE](LICENSE)), except `lib/`, which is MIT
([lib/LICENSE](lib/LICENSE)) so other clients can use the encryption and
the card model.
