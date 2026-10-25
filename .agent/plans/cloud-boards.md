# corkboard cloud: boards, notes and MCP on Cloudflare

**Written:** 2026-10-24 · **Decided:** single user for now; Cloudflare is the only store (local
boards imported once, then retired); Pepper's memory lives here too.

Boards move from `~/.local/share/corkboard/boards/*/tasks/*.md` to a Cloudflare Worker. Everything
that reads or writes a card goes through it: corkboard's UI (via the bridge), the card agents
corkboard spawns, Pepper in its VM, and claude.ai as a custom connector. Nothing else holds
card state, so nothing can drift.

---

## Why

- **One writer per board.** A Durable Object serializes writes. The per-card mkdir locks, rename
  writes and the "must agree byte for byte" contract between `cards.lua` and `mcp/cards.ts` go away.
- **One interface for agents.** An MCP server with per-token scopes replaces mounting a board
  directory into whatever needs it. Shares turned into outboxes; an API cannot pile up unapplied
  files.
- **Every machine sees the same boards.** corkboard over `spawnRemote` (another host, a VM) today
  reads that machine's `~/.local/share`; after this, the same boards everywhere, and from the phone.

Lost on purpose: the Backlog.md CLI on the files, and working offline (see Offline).

---

## Shape

```
                 ┌──────────────── corkboard Worker (corkboard.<domain>) ───────────────┐
browser ─ bridge ┤  /api/*   REST + /api/live WebSocket   (session cookie)              │
card agents ─────┤  /mcp     MCP, streamable HTTP          (OAuth bearer, scoped)        │
pepper-vm ───────┤  /authorize /token /register  OAuth 2.1 + DCR (workers-oauth-provider)│
claude.ai ───────┤                                                                      │
                 │  UserDO (one per user): board list, notes, plans, token grants       │
                 │  BoardDO (one per board): cards, log, live sockets  — SQLite storage │
                 └──────────────────────────────────────────────────────────────────────┘
```

- **Worker:** TypeScript, `@cloudflare/workers-oauth-provider` wrapping the app; `agents`
  (`McpAgent`) for `/mcp`. Deployed with `wrangler`, config in `cloud/wrangler.jsonc`.
- **Storage:** SQLite-backed Durable Objects (`ctx.storage.sql`). `BoardDO` per board, `UserDO` per
  user. No D1 needed while there is one user; boards are found through the user's `UserDO`.
- **Live updates:** the bridge holds one WebSocket per open board (hibernatable, so idle boards
  cost nothing). The DO broadcasts a change event after each committed write; this replaces the
  `fs_event` watcher in `board.lua`.

### Login

Single user, but keyed by user id everywhere so collaborators later are a permissions change, not
a data migration.

- Upstream identity: **Google sign-in**, allow-listed to `matthewjurenka@gmail.com` (a Worker
  secret). Anyone else gets a 403 after login.
- The OAuth provider is the corkboard's own: it issues the session for the UI and the bearer tokens
  for MCP clients. claude.ai and Claude Code both do the OAuth dance themselves (DCR).
- The bridge stores a refresh token in `~/.local/state/corkboard/auth.json` (0600) after a one-time
  `corkboard login` (opens the browser).

### Scopes

Tokens carry a grant the Worker checks on every call. MCP tools are filtered by it, so an agent
never even sees a tool it may not use.

| Grant | Who | Can |
|---|---|---|
| `owner` | the UI session | everything, including **accepting a plan** |
| `card:<board>/<id>` | a card agent corkboard spawns | read its board; claim, log, update, block on that card; create child cards |
| `assistant` | any OAuth MCP client (Claude Code sessions) | read all boards and notes except goals; create and update cards; write notes; **propose** plans |
| `pepper` | Pepper's session, with a token the bridge mints as owner (`/api/tokens/pepper`) | what `assistant` can, and the `goal` notes, which no other grant sees over MCP |
| `connector` | claude.ai | same as `assistant` (phone use) |

Card tokens are minted by the bridge (it calls `/api/tokens` as owner) when it starts an agent, and
expire when the card's session ends. Accepting a plan exists only under `owner`, in `/api`, and has
no MCP tool, so no agent can approve its own plan.

### Data

```sql
-- BoardDO
cards(id TEXT PRIMARY KEY, title, status, ordinal, agent, agent_state, attention,
      labels JSON, dependencies JSON, description, created, updated, version INTEGER)
log(card_id, at, who, note)             -- the NOTES section, as rows
-- UserDO
boards(key PRIMARY KEY, name, root)     -- root: the local path corkboard maps it to
notes(id, kind, title, body, updated)   -- kind: goal | day | decision | project | person | review | memory
plans(date, version, state, blocks JSON, ranked JSON, feedback JSON)   -- state: proposed | accepted
grants(token_hash, grant, expires)
```

Every write takes the `version` it read; a stale version is a conflict error, not a silent
overwrite (the UI and an agent editing one card at once).

---

## MCP tools

The current 12 tools from `mcp/board.ts` keep their names and semantics: `list_cards`,
`read_card`, `next_card`, `claim_card`, `release_card`, `update_card`, `write_description`, `log`,
`create_card`, `block`, `request_user_action`, `submit_for_review`. They gain a `board` argument
(defaulting to the token's own board for card agents). New:

- `list_boards`
- `notes_search`, `note_read`, `note_write` — Pepper's memory (kinds above)
- `plan_read`, `plan_propose` — the day plan; `plan_feedback` reads what Matt said in the plan tab

`attention` and `request_user_action` keep notifying the desktop: the bridge sees the change on the
live socket and corkboard raises the notification as it does now.

---

## corkboard changes (`~/agent-ide`)

- **`cloud/`** (new): the Worker, its DOs, tests (`vitest` with `@cloudflare/vitest-pool-workers`).
- **`bridge/server.ts`:** `corkboard login`; one live socket per open board; forwards changes to
  nvim as an RPC notification; proxies writes from nvim; mints card tokens.
- **`nvim/lua/corkboard/cards.lua`:** same functions (`list`, `get`, `set`, `change`, `log`,
  `create`, ...), backed by a replica the bridge keeps current instead of files. Callers
  (`board.lua`, `plan.lua`, `review.lua`, `usage.lua`, `agents.lua`) don't change. Writes become
  `rpcrequest` to the bridge.
- **`agents.lua`:** `--mcp-config` points at the Worker's `/mcp` with the card token
  (`{"type":"http","url":...,"headers":{"Authorization":"Bearer ..."}}`), not `bun mcp/board.ts`.
- **`plan.lua`:** reads `plans` instead of `plan/sample.lua`; `A` calls the owner-only accept, then
  runs `dayplan apply` on the host with the accepted blocks.
- **Retired:** `mcp/board.ts`, `mcp/cards.ts`, the card-file format, the board directory watcher.
- **`corkboard import`:** one-time; reads every `~/.local/share/corkboard/boards/*/tasks/*.md`,
  writes each board (ids, logs, statuses, dependencies kept), then renames the local directory to
  `boards.imported-<date>` rather than deleting it.

## Offline

No offline writes in v1. The bridge's replica keeps the board readable when the connection drops
(marked stale in the UI), and writes fail loudly. Queued offline writes are a later decision, and
they would bring conflicts back.

## Build order

1. Worker + `BoardDO` + REST, with the card model and versioned writes; tests. **Built
   2026-10-24** in `cloud/` (`Board` DO, `src/cards.ts` model, 12 tests). Until step 2 it accepts
   one bearer token, the `DEV_TOKEN` secret, and every board belongs to one placeholder owner.
   Deployed to `https://corkboard.matthewjurenka.workers.dev` (Cloudflare account
   `main@matthewjurenka.com`); the token's host copy is `~/.local/state/corkboard/dev-token`.
2. Login (Google, allow-list) + `UserDO`; `corkboard login` in the bridge. **Built and deployed
   2026-10-24.** `cloud/src/auth.ts` (consent page → Google → `/callback`), `src/user.ts`, the API
   behind the provider's token check (`owner` scope); boards must be made with
   `PUT /api/boards/:key` before they take cards. Google client: the `dayplan-512206` project's
   Web application client, redirect URI `…/callback`. Bridge side: `bridge/cloud.ts`
   (`bun run login`; `token()` refreshes). `DEV_TOKEN` is gone. 27 tests, including the whole
   sign-in flow with Google's token endpoint stubbed.
3. Bridge replica + live socket; `cards.lua` on top of it. corkboard works against the cloud.
   **Built 2026-10-24, off by default** (`CORKBOARD_CLOUD_BOARDS=1` turns it on) until step 5
   moves card agents off the files. Worker: `GET /api/boards/:key/live` (hibernatable socket,
   a `BoardEvent` per write), `?log=1` on the card list, log entries carry `seq`,
   `DELETE /api/boards/:key`. Bridge: `bridge/boards.ts`, one socket per board shared by
   sessions, a fresh copy on reconnect. Neovim: `nvim/lua/corkboard/cards/cloud.lua`, same
   functions and card shape as the file backend. Neovim asks with a notification plus
   `vim.wait` on an id, **not** `rpcrequest`: requests nest (a scheduled board refresh is
   waiting when the page's call asks for cards), and nested `rpcrequest` only accepts the
   innermost answer, which the bridge can't know. End to end: `bun run test:cloud`.
4. `corkboard import`; retire the files. **Imported 2026-10-24**: `bun bridge/import.ts`
   (`--dry-run` to look first) copied home-matthew-agent-ide (14 cards, 30 log entries) and
   home-matthew-nixosconfig (1 card) through `POST /api/boards/:key/import`, which keeps ids,
   times, logs and extra fields and only fills an empty board; every card read back identical.
   The cloud backend is now the default under the bridge (`CORKBOARD_CLOUD_BOARDS=0` for the
   files). The local folder is now `~/.local/share/corkboard/boards.imported-2026-10-24`, and
   `.mcp.json` points Claude Code at the Worker's `/mcp` (OAuth; it asks for `assistant`,
   which the Worker's challenge names). Checked that a card agent's `--mcp-config` wins over the
   project's `corkboard` server of the same name. `mcp/board.ts` and `mcp/cards.ts` are now only
   for `CORKBOARD_CLOUD_BOARDS=0` and Neovim run without the bridge.
5. `/mcp` with grants; switch `agents.lua`; retire `mcp/board.ts`. **Built and deployed
   2026-10-24**, except the retiring: `mcp/board.ts` stays for file boards until step 4 flips the
   default. `cloud/src/mcp.ts`: the same 12 tools over stateless streamable HTTP (POST only,
   JSON answers). Card tokens: `POST /api/tokens` (owner) → `cbc_…`, kept as a SHA-256 in
   `OAUTH_KV` for 7 days, accepted through the provider's `resolveExternalToken`; they reach
   `/mcp` only, and change only their own card (read the board, make follow-ups of it). OAuth
   `owner`/`assistant` tokens get `list_boards` and a `board` argument on every tool.
   `agents.lua` in cloud mode writes the agent's `--mcp-config` to a 0600 file under
   `stdpath("state")/corkboard/agents/` and revokes the token when the agent exits. Checked with
   a real `claude -p` session against the Worker. 46 Worker tests; `bun run test:cloud` covers
   the agent path end to end.
6. Notes + plans + their tools; `plan.lua` on real data. (This is what Pepper needs.)
   **Built and deployed 2026-10-24.** The `User` object holds notes (FTS5 search) and plans
   (`cloud/src/plans.ts`): per date, the day, an optional proposal, and what the user said to
   change; versioned like cards; `GET /api/live` sends each plan change. MCP (OAuth only):
   `notes_search`, `note_read`, `note_write`, `note_append`, `plan_read`, `plan_propose`; no
   accept tool; the `soul` note is owner-only. The day plan has its own window (one at a time);
   `plan.lua` reads the plan through the bridge and follows it live, and `A` runs
   `dayplan apply` on the host before telling the Worker; an empty plan isn't accepted, since
   accepting opens the gate. `bun run test:plan` runs it end to end on a 2099 date with a
   stand-in `dayplan`.
7. claude.ai connector (`connector` grant).

## Open

- Domain: a `workers.dev` subdomain to start, or a custom one?
- Who writes the Claude calendar on accept: the host's `dayplan apply` (as above, no Google
  credential in Cloudflare) or the Worker holding a Calendar token? Host is the default.
