# Local-first, encrypted boards: the Worker keeps no cards

**Written:** 2026-11-05 · **Decided:** boards go the way memory went (local-memory.md): a board is
an encrypted replica (lib/e2ee/sync.ts) on the user's devices, the node serves it, and the Worker
keeps only ciphertext. Open decisions are under **Decide**.

Today a board is plaintext in the Worker's Board DO (`cards`, `log`, `leases`, `meta`), its media
in R2, and its name, root and remotes in the User DO. Every client goes through the Worker:
Neovim (bridge/cloud-session.ts), agents' `/mcp` with a card token, fleetd's claim, Pepper's
`create_card`, the portal's board list, the phone's plain screens. The Worker also writes cards
itself: the lease alarm blocks a quiet agent, and fleet.ts claims a card at spawn and moves it on
approve, stop and report.

The node already has most of a board: lib/e2ee/merge.ts's card and log ops, data.ts's cards,
mcp.ts's card tools (all but `attach_file` and `create_board`), the phone's `/api/node/boards`,
and `e2ee push-board` copying a Worker board into a replica. What's missing is everything around
the cards.

---

## The shape

```
app ── bridge ── node ── replicas (disk) ── relay (ciphertext)
agents, Pepper, fleet slots, claude.ai ── /mcp ── node (local, or /n/<handle>/ to the leader)
phone ── relay directly (Encrypted.kt), as a paired device
```

- **The node is the board's server.** Neovim's `corkboard.cloud` board ops (`resolve`, `boards`,
  `subscribe`, `make`, `create`, `update`, `log`, `archive`, `delete`, `touch`, `token`, `revoke`)
  go to the node, as `brains_*` do (boards.ts). Events come from `Replicas.onChange` as
  `BoardEvent`s, so a change on another device shows at once.
- **Agents' MCP is the node's.** A session's `corkboard` server is the node's `/mcp` with a grant
  bound to its card (a new OAuth grant kind, like the Worker's `card` and `session` grants), on
  loopback for local sessions and through the tunnel for slots and Pepper. The leader does what
  the Worker's lease alarm did.
- **Typed board records.** A board replica holds cards and, by prefix, `board` (name, root, first
  commit, remotes, environments' roots), `media:<id>` (an attachment: blob id, name, type, size,
  card), and `extra:<card>:<key>` per key, so two devices setting a worktree and a media list
  don't lose one. `Data.cards()` reads only card records.
- **Attachments are blobs.** sealBlob under the board's key, on the relay's blob routes. The
  node serves them to the page (the bridge's `/media/...`) and takes uploads (`attach_file`'s
  upload URL, on the node).
- **Nothing on the Worker reads a card.** It keeps the relay, the tunnel, accounts, and (until
  their own move) plans, chat and the fleet's queue, which name a board and card by id only.

## Build order

1. **Typed board records.** `board`, `media:`, `extra:` records; `Data.cards()` filters them;
   push-board writes them. The card id scheme (see **Decide**). Tested: concurrent `extra` keys
   from two devices both survive; two devices creating cards offline don't merge them.
   **Built 2026-11-05.** bridge/node/board.ts: `BOARD_RECORD`, `mediaRecord`, `isCard`, extra as
   `extra.<key>` fields over a whole `extra` (`extraOf`, `extraSet`), `newCardId` (TASK-7F3K),
   `settingsOf`, and push-board's `changesFor` moved there. data.ts's `board`/`putBoard`,
   `boards()` with name and root (so `list_boards` gives them), cards only from card records.
   lib/model's `cardId` takes `[0-9A-Z]{1,12}` after the dash; cloud.lua sorts ids that aren't
   numbers by `created`. Test: "a board's own records" (76/76). Not yet: the phone's encrypted
   screens (EncryptedScreens.kt) list every record as a card, `board` and `media:` too.
2. **Neovim's boards on the node.** boards.ts routes the board ops to the node when it has the
   board; `subscribe` follows `Replicas.onChange`; `update`'s 409 becomes per-field merge (no
   conflict to refuse); `addBoard` for `make` and boards another device adds while it runs;
   `APP_OPS` takes the board ops so a `--dev` bridge works too, and `/app` checks it's on
   loopback rather than relying on the tunnel not being given it.
   **Built 2026-11-05.** boards.ts's Session sends a board's ops to the node (app.ts's `boards`)
   when the node has it and the Worker answers 404 or 410 for it, or when signed out (then every
   board, a new one too); a board push-board copied stays the Worker's until step 7 moves it, so
   the two copies don't part. `boards` merges both lists, `resolve` both boards' commits.
   `subscribe`/`make` take the clone's place (root, environment, commit, remotes) and keep
   each environment's root in `board.roots`; `make` keeps the board (serve.ts's `addBoard`).
   `update` gives `{card}` and never conflicts; `delete` marks the record `deleted`;
   `touch` is a no-op until step 3; `token`/`revoke` stay the Worker's. app.ts's
   `boardEvents` diffs each board after `Replicas.onChange` into `card`/`log`/`removed`
   events, and a `snapshot` when a card comes back with its log or the log's order shifts.
   Boards another device adds to the index are kept from the next index sync (replicas.ts's
   `discover`). `/app` takes `board_<op>` and is loopback only (Bun's requestIP; the tunnel
   gives no peer); `/app/events` streams the events to a second bridge as server-sent events,
   which resends each board whole after a drop. A node older than this (an installed bridge's)
   leaves every board the Worker's. Tests: "Neovim's boards, on the node", and /app's (78/78).
3. **Card grants and leases on the node.** oauth.ts's grant kinds `card` (its own card only) and
   `session` (the Worker's `SESSION_TOOLS`); `token`/`revoke` mint and end them; agents.lua's
   config points at the node. Every call touches the lease; the leader blocks a card whose agent
   has been quiet 15 minutes, as board.ts's alarm does.
   *Built 2026-11-05:* oauth.ts's `Kind` adds `card` and `session` to the scopes; `mintBound`
   makes one (a week, its grant with `expires`, which every node drops then), `revokeToken` ends
   it; server.ts lets a board-bound token into /mcp alone. mcp.ts gates as the Worker's does
   (`card: "any"|"own"` per tool, SESSION_TOOLS, no board argument, no memory tools, next_card
   only its own card, create_card's parent and attention rules, handoff on its card). app.ts's
   `token` (`{token, expires_at, url: <node>/mcp}`), `revoke` and `touch`; boards.ts routes them.
   leases.ts: `lease:<card>` records `{agent, until, lapsed}` in the board replica, written at
   most once a minute; every MCP call touches (a claim after it runs too); the node that
   `leads()` sweeps each minute. A working card with no lease record of its agent's is left
   alone: it's a board still the Worker's. Tests: "card grants and leases, on the node" (81/81).
   Not yet: fleet's session grants come from the Worker (step 5); the node's port changes on a
   restart, so a running agent's config points at a dead port (as session-mcp.json does);
   Android lists `lease:` records as cards too.
4. **Attachments.** `attach_file` and its upload URL, `/media/...` from blobs, the page's
   Media view unchanged. The blob limit (25 MB, the Worker's is 100 MB): raise it, or chunk.
   Built 2026-11-05, chunked (the user's choice): bridge/node/media.ts seals a file in 16 MB
   pieces, each a blob, named in order by its `media:<id>` record (card, name, type, size, at,
   who, blobs, epoch); pieces are kept in <state>/node/blobs too, and fetched from the relay
   when missing. Data.cards() folds the records into extra.media (and the card's version).
   attach_file on the node (inline under 4 MB, or an offer: PUT <origin>/upload/<token>, an
   hour, once, kept in memory); GET /api/node/boards/:key/cards/:id/media/:mid; the bridge's
   /media asks AppNode.media first, then the Worker; delete forgets the files. Test: "cards'
   files, on the node" (82/82). Not yet: an upload through the tunnel stops at 17 MB
   (LIMITS.tunnel), so a remote agent's big file needs uploads in parts (step 5); a local-only
   account's pieces never reach the relay when it's published later; no Range requests.
5. **Remote agents on the tunnel.** Pepper's `corkboard` MCP and fleet slots' `mcp.json` go to
   `/n/<handle>/mcp`; claude.ai's connector too. The fleet's card lifecycle (see **Decide**).
   Decided 2026-11-05: Pepper's `corkboard-memory` server drops `?tools=memory` and so serves
   the card tools too; the Worker's `corkboard` hides card tools from a brain grant and keeps
   plans and chat. fleetd holds a node owner token (minted by hand, as Pepper's memory-token),
   mints and revokes slots' card and session grants with the node's `POST`/`DELETE
   /api/node/grants` (owner only, tunnel-reachable, the grant's url the tunnel's), and writes the
   claim, running, done/failed and stop to the card with `/api/node/boards`; the Worker's queue
   keeps ids and touches no card. `spawn_agent` with a card moves to the node (its MCP and
   Neovim's spawn): the node checks and marks the card, then queues the spawn on the Worker
   with ids only. Slots' memory hooks go to `/n/<handle>` too.
   **Built 2026-11-05.** The node's `POST`/`DELETE /api/node/grants` (card, session and brain
   grants, owner only) and `GET /api/node/boards/:key` (its roots, for the slot's repo). fleetd's
   manifest takes `node {url, tokenFile}`; for a `node` spawn queue.ts's `equip()` gets the
   slot's grant, repo and brain memory from the node, writes running/done/failed/stopped on the
   node's card, and revokes the grants there; slots' memory hooks take the node's url. The
   Worker's `spawn()` takes `node: true` (the ids checked by shape only: no board read, no card
   touched, no grant or repo at the claim) and `GET /api/fleet/status` answers the node's
   spawn_status. The node's mcp.ts has the Worker's four spawn tools (owner or assistant, no
   brain): on a board the node has it checks the card, queues with `node: true`, and marks and
   logs the card; any other board's spawn is the Worker's, unchanged. Neovim's `fleet_session`
   on a node board sends `node: true` (boards.ts). Pepper's corkboard-memory server is the
   node's whole /mcp; the Worker hides the board tools from a brain's token once the account has
   no board there (so not until step 7). Tests: "the fleet's spawns, from the node" (86/86),
   fleetd's (22/22), the Worker's fleet.test.ts. Not yet: claude.ai's connector at
   `/n/<handle>/mcp` (the user adds it); uploads in parts through the tunnel.
6. **The portal and the phone.** The portal's board list, Add project and `/open` tickets,
   which need a board's name, root and remotes; the phone's plain board screens (NewSession's
   picker, Media) read the encrypted replica its pairing gives it.
7. **Moving off the Worker**, as move.ts does memory: `POST /api/boards/move` freezes the
   account's boards (Board DO lookups throw `Moved`, routes 410), `GET .../move/:board` pages
   out `cards`, `log`, `meta` and the R2 media, the node writes them into replicas with their
   own times and checks nothing is missing, waits for `settled()`, then `.../done` destroys each
   Board DO, forgets the R2 prefix and the `card-token:*` KV entries, and clears the User DO's
   board rows. `e2ee move-boards [--dry-run]`.

## Decide

- **Card ids** (decided 2026-11-05): a new card is `TASK-` and four random characters of
  Crockford's base32, which can't collide offline; existing cards keep their `TASK-n`.
- **The fleet's queue** (decided 2026-11-05): it stays on the Worker holding only board and card
  ids; fleetd and the slot read the task from the node through the tunnel, and the node writes
  the claim and report to the card (fleetd gets a grant from it). The queue moves later, with
  plans and chat.
- **Finding a board by its first commit** (`resolve`, `?commit=`): the Worker answers from
  plaintext rows. On the node it's the index's `board` records, which every device has.
  The Worker keeps nothing. (No choice needed unless the portal must find boards with no node up.)
- **With no node up**, the portal's boards, claude.ai's cards and fleet slots don't work (the
  phone and the desktop do, from their own replicas). That's the e2ee plan's trade.

## Open

- Sharing a board with another account: the grants exist (lib/e2ee sharing); no UI.
- The wasm page (web/src/nvim/wasm/rpc.ts) runs cloud-session.ts in the browser with no machine;
  it would need lib/e2ee in the page and the root, which e2ee.md's open question on the page's
  trust boundary covers.
