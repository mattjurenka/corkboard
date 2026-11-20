# Test coverage: what corkboard does, and what's tested

Made 2026-11-20 from six read-only sweeps (bridge, bridge/node, lib+relay+mcp, nvim, web+wasm+app,
fleet+forge+nix+CI), each grepping the tests for every route, op, tool and function. Coverage marks:
T tested, P partial (some paths, or only the backend under a UI), U untested.

The marks are from before the tests on agent/1114-170034/integration (git log 6d0b689..), which
cover much of what they call P and U; section 0 is done there (test:lib, test:bridge, test:mcp,
test:nvim, test:web, test:terminal and a nix job in ci.yml), but multi-node.

## 0. CI first: tests that exist but run nowhere

CI is `.github/workflows/ci.yml`: typecheck, `test:fleet`, `test:e2ee`, `vite build`, relay vitest,
`scripts/smoke-bridge.ts` (linux/mac/win). It installs no nix and runs:

- no `nix flake check`: not `checks.fleet` (18 lib.nix tests), `checks.multi-node` (the only e2e),
  `libuv-smoke`, `nvim-smoke`
- not these 10 bun files: `lib/think.test.ts`, `lib/acp/{agy,client,codex}.test.ts`,
  `fleet/caps/browser-mcp.test.ts`, `nvim/away.test.ts`, `nvim/hooks/{session,ui-mcp}.test.ts`,
  `nvim/claude-plugin/hooks/work.test.tsx` (needs the claude-code/testing runtime),
  `web/src/nvim/{grid,terminal}.test.ts` (terminal needs nvim on PATH)
- typecheck leaves out fleet/guest, fleet/caps, nvim/*.ts, bridge/*.ts outside bridge/node, bridge/wasm.ts
- `lib/harden.ts`, `lib/dict.ts`, `lib/testing/`, `scripts/lint-keys.ts` (the ~/.claude/CLAUDE.md
  prototype-key rule) are on other branches (commits 6679bea, 50eb7bb), not on this one or main's
  checkout in ~/corkboard. So lint-keys isn't in CI here.

Cheapest big win: one `test:all`-ish script plus CI steps for the above (nvim on the runner; nix
job for `checks.fleet` at least, multi-node if a KVM runner exists).

## 1. Well covered (T)

- lib/e2ee: keys, records, blobs, box, phrase, certs, revocation, pairing (MITM, QR, commit,
  reveal+delivery), sharing/grants/rotation (happy path), merge, Replica sync/compact/rekey,
  channel (MITM, replay, window, revocation), forge capability chains
- relay: accounts, challenge/token, revoke, rotate, pairing mailbox, grants, logs, snapshots,
  blobs (basic), nodes + tunnel + channels, relay-only gating, silent node drop (new)
- bridge/node (node.test.ts, 2235 lines): OAuth DCR/authorize/token/refresh, /api/node cards,
  brains, notes, recall, entries import, plans+chat, meditation, feeds, fleet spawns/holds/env,
  /memory context+episodes, MCP board/memory/plan/files/PR tools, consolidator (6), handoff,
  embeddings recall, leases, calendar writer, Forgejo process + snapshots, sealed fleet, media,
  hub sessions, peers, Neovim board/plan ops
- fleetd: scheduling, queue, git grants, actions runner, node channel, assistant helpers;
  fleet/guest acp; fleet/lib.nix (nix, not CI)
- forge/gate: binding, nonce sessions, grants/scopes, push ref filter, revocation
- bridge: keystore + ReplicaDb, forge grant/status
- multi-node VM: pair/recover, card+note sync, leader+forge, episode handoff, failover

## 2. Riskiest untested, by area (pick from here)

Security boundaries
- bridge/server.ts `/nvim` websocket: token, Origin/Host, DNS-rebinding refusal (server.ts:115-146,776)
- forge/gate `POST /gate/account` key rotation (Store.rotate); `..`/`//` path rejection, 64 MiB 413,
  wiki-push ref bypass, 415 encoding branch (proxy.ts:38,51-57,95)
- node MCP `pair_device`/`pair_confirm` (mcp.ts:516) and app ops `nodes_leader`/`nodes_forge`
  (app.ts:337, flips forgeWeb = plaintext tunnel access)
- node OAuth: client-ID metadata document fetch (SSRF guard, oauth.ts:307), confidential-client
  auth (oauth.ts:337), consent deny/expiry (server.ts:238)
- relay: Mailbox alarm deletion (mailbox.ts:58), challenge/token TTL expiry, live socket dropped on
  ungrant (routes.ts:448 Log.drop), blob/tunnel 413, tunnel 501/504, owner blob DELETE, 405s
- lib/e2ee/forge-client.ts `sendRevocationToGate` (gate keeps honouring a revoked grant if broken)
- web/src/lib/markdown.ts sanitising (dangerouslySetInnerHTML in Viewers.tsx:195, Conversation.tsx:243)
- fleet/host/host.nix nftables/proxy/dnsmasq allowlist and its build-time assertions: never evaluated
- e2ee CLI rotate/rotated/revoke/publish/init --local (bridge/e2ee.ts:590,609,619,148,114)

Data loss
- mcp/board.ts + mcp/cards.ts (13 local MCP tools, Backlog.md parse/serialize, mkdir lock,
  holder() check): zero tests. Same for nvim cards.lua round-trip.
- lib/memory/consolidate.ts parseRollup guards (MIN_RETAIN, MEMORY_MAX, empty) — happy path only
- node app ops brains_create/update(stale)/archive/restore/purge (app.ts:420-442)
- nvim worktree.lua make/finish/drop; git.lua merge PR (m) / remove worktree (d); review.lua A/S
- nvim autopilot groom/undo_groom; restore.lua editor.json
- meetings: bridge record/listen/transcribe/propose — nothing at any layer

Core flows used daily
- node MCP block, request_user_action, submit_for_review, release_card, write_description,
  note_read, brain_read, items; budget_hold refusal in callTool (mcp.ts:957)
- bridge boards.ts Session.call routing; cloud-session.ts Worker client (fleet_*, live sockets,
  409s); sessions.ts Worker follow + conversation stream; away.ts wake/chime rules
- lib/e2ee Relay.subscribe reconnect + cursor resume (relay.ts:244); channel.ts wsLink silent timeout
- node runningNode client (second bridge, app.ts:170); leader() fallback/cache and keepForge loop
  (serve.ts:186,318) only by the VM test
- nvim agents.lua take/schedule/hook (both hook tests stub it); budget.lua; usage/transcript.lua
- fleetd.ts slot start/tick, sessions.ts, assistant `assist`, corkboard-fleet CLI
- web input.js (keys, IME, paste, mouse, touch), reconnect (main.tsx:306), Settings controls

Build drift
- flake packages `fleet` and `forge-gate` have hand-listed filesets, built by nothing
- packaging/aur and homebrew update.sh: never run

## 3. Cheap pure-function wins

web: lib/nav.ts, lib/keys.ts, Palette.matches, Panels.holes, Usage.parseAdvice, voice.sentences,
Board.yourTurn, lib/markdown.ts. lib: model/dates.range branches, Replica.queued/worthCompacting,
wire.showCode. bridge: away.ts reason(), dirs.pathKey/isUnder. relay: the 405s.

## Dead code found

data.importNote, importPlan, importChat, fleet.importHolds, media.restore (bridge/node): no callers.
