# Local-first, encrypted memory: one store, signed in or not

**Written:** 2026-11-04 · **Decided:** a brain's memory is kept only encrypted off the machine, and
what reads it (embeddings, consolidation) runs on the machine. A board or brain is the same
encrypted replica (lib/e2ee/sync.ts) whether the user has signed in or not: signed out, its store
on disk is the truth and its changes wait in its queue; signing in registers the account with the
relay and pushes them. Nothing is converted at sign-in.

Today a hosted brain's memory is plain text in the Worker (corkboard-cloud's memory.ts): notes,
the log, transcripts, embeddings by Workers AI in Vectorize, and consolidation run in a fleet
slot. The node (bridge/node/) already serves notes, the log, recall and the memory tools from
encrypted replicas, but only for an account made at a relay, and with no episodes, embeddings or
consolidation.

---

## The shape

```
signed out:  app ── bridge ── node ── replicas (disk)                     no transport
signed in:   app ── bridge ── node ── replicas (disk) ── relay (ciphertext)
```

- **An account made on the machine.** The root, account keys, device and its certificate are all
  made locally (`certify` needs only the root), so `e2ee init --local` makes an account with no
  relay. `e2ee publish` later creates it at the relay (`/e2ee/accounts`; the hosted relay admits
  anyone), signs in, and pushes every replica's queue. The recovery phrase is the same before and
  after.
- **No transport is a transport.** `offline` (sync.ts) refuses every call; Replicas over it keep
  changes in the queue and never push, sync, follow or compact.
- **Episodes stay on the device that recorded them.** A transcript is up to 16 MB, too big for an
  op and not worth syncing: it's input to consolidation, which runs where it was recorded. Kept in
  the node's own SQLite. What consolidation makes from it (log entries, the `memory` note) syncs
  as records.
- **Embeddings are made once and shared.** transformers.js (already a dependency) with a small
  model. The node that wrote a text (the one a session ran on) embeds it and shares the vector as
  a `vector:<hash>` record in the brain's encrypted replica, int8 (~0.5 KB); other devices use it.
  (Changed 2026-11-04 from "a local cache, never synced", at the user's ask.)
- **Consolidation on the node.** The Worker's consolidator (prompts and the checks on what comes
  back) moves into this repo as `lib/memory/`, and the node runs it with `claude -p` on the user's
  own account after a session has been quiet for its time. Text comes back; only that code turns
  it into memory, as before.
- **The app uses the node.** The bridge runs the node in-process. The Brains tab, its memory
  browser, a session's memory tools and its hooks (`/memory/context`, `/memory/episodes`) all go
  to it. Every local session gets the hooks, not only fleet slots.

## What's on disk

`<state>/e2ee/replicas/*` holds decrypted merged state, as it does for the node today, readable
only by the user (0700). Off the machine there is only ciphertext. The node's SQLite
(`<state>/node/memory.db`: episodes, vectors) is the same: local, plain, the user's alone.

---

## Build order

1. **Local accounts and an offline node.** `offline`; Replicas that don't push over it;
   `e2ee init --local` and `e2ee publish`; `serve` with no relay. Tested: a brain written offline,
   then published, reaches a second device whole.
   **Built 2026-11-04.** `offline`/`Offline` in sync.ts; `Replicas.online`, and pushes, syncs,
   `start` and the index's push skipped over it; the keystore's `relay` may be null; `e2ee init
   --local` and `e2ee publish` (bridge/e2ee.ts); `serve` over `offline` when the device has no
   relay. node.test.ts's "an account only on this machine" checks it. The CLI commands typecheck
   but haven't been run (they'd write the real keystore).
2. **A SQLite replica store**, so a brain with thousands of entries isn't one JSON file rewritten
   on every change.
   **Built 2026-11-04.** bridge/replicadb.ts: `<e2ee>/replicas.db` (WAL, 0600), a row per card and
   per queued op. `ReplicaStore.save` is told the cards changed since the last save (`Replica`
   tracks them; a snapshot taken is "any"); the queue is matched by op id and nonce. A replica's
   old `replicas/<object>.json` is moved in and removed when first opened. keystore.test.ts.
   (Also: `remember`'s ids strictly increase within a process, so two entries in one
   millisecond keep their order; that was node.test.ts's flake.)
3. **Episodes and the hooks' routes on the node**, and the hooks installed for local sessions.
   **Built 2026-11-04.** bridge/node/episodes.ts (`<state>/node/memory.db`; the Worker's rules: a
   retried hook kept once, a session's newer transcript replacing its unread one; `onAdded` for
   the consolidator). server.ts's `/memory/context`, `/memory/episodes[/:id]`, with a node token,
   `?brain=` or the default. nvim/hooks/claude-memory.lua on SessionStart, PreCompact and
   SessionEnd of every local session (claude.lua), acting only when `CORKBOARD_MEMORY_URL` and
   `CORKBOARD_MEMORY_TOKEN_FILE` are set, which step 6 does; the token goes to curl on stdin.
   Checked against a live node with the hook run as `nvim -l`.
4. **Local consolidation** (`lib/memory/`, moved from corkboard-cloud).
   **Built 2026-11-04.** lib/memory/consolidate.ts (the Worker's, verbatim but its header; the
   Worker's copy stays until step 7). bridge/node/consolidator.ts: the Worker's `consolidation`,
   `consolidated`, `rolledUp`, `due` (its `consolidateAt`) over Episodes and Data, ticking each
   minute (unref'd, one run at a time, an injectable clock); an episode waits QUIET after its last
   upload; a failed run backs off an hour, doubling to a day (episodes.ts's meta). `think` is
   `claude -p --tools "" --strict-mcp-config --setting-sources "" --system-prompt-file F
   --output-format json` in an empty temp dir, input on stdin, CORKBOARD_NO_MEMORY=1, `.result`
   (checked against the real CLI). Days with no log are rolled past (the synced `rollup` record);
   soul suggestions go in the log as the consolidator's. `addEntries` ids carry the bullet's place,
   so an episode's bullets keep their order. Started from serve.ts; node.test.ts's "the
   consolidator" with a fake think.
5. **Local embeddings** behind search.ts's `Embedder`.
   **Built 2026-11-04.** bridge/node/embed.ts: `LocalEmbedder`, Xenova/bge-small-en-v1.5 (q8, 384
   dimensions, CLS pooling, bge's query prefix) through transformers.js, found as speech.ts's
   sidecar is. Vectors are shared, not cached per device: `vector:<hash>` records in the brain's
   replica (objects.ts; data.ts's `vector`, `vectorHashes`, `putVectors`), the hash of model and
   text, int8 with a scale (scores within 1e-4 of float). A node embeds only what no record has,
   writes those, and nulls the records of texts gone. Long items in ~1500-character pieces with
   their title; an item scores as its best piece; the top 40 go into recall's rank fusion.
   Embedded at once after the consolidator's run for a brain (`after` → `Search.share`), a
   minute after any other change (by then another device's arrive with their vectors), on recall
   for anything still missing, and each brain at serve's start. node.test.ts's "recall by
   meaning": a laptop embeds, a desktop recalls embedding only the question. Checked with the real
   model (4 s cold with the download, 4 ms warm). Every brain record is in the replica, so a
   brain of thousands of entries carries ~0.5 KB more per entry; a separate vectors object is the
   way out if that's slow.
6. **The app on the node**: the bridge starts it, with a default brain on first run; the Brains
   tab, the memory browser and sessions' MCP read it.
   **Built 2026-11-04.** bridge/node/app.ts's `startAppNode`, from server.ts's start: serve.ts's
   `run` is now `startNode` (loopback, a port of its own), under a pid lock (`<state>/node/lock`)
   so `serve` and the bridge never both run one. No keystore and not signed in, it makes the
   account here (`e2ee init --local`'s `localAccount`; `e2ee phrase` prints its recovery phrase)
   and the Worker's starter brain, `assistant`. Signed in with no account (today's users), it
   doesn't run, and memory stays the Worker's until step 7. Sessions get an assistant's token
   (`<state>/node/session-token`, minted once) and `session-mcp.json`, the node's
   `/mcp?tools=memory` (the memory tools only), which claude.lua passes local sessions as
   `--mcp-config=`; CORKBOARD_MEMORY_URL/_TOKEN_FILE/_MCP_CONFIG are in Neovim's environment.
   boards.ts's `Session.call` sends `brains_*` to the node, in the Worker's shapes (a stale
   `updated` answers `{ stale }`; `putBrain` moves `updated` a second on within one), with
   `Replicas.add` for a brain made while it runs. Not yet: purge (refused), holds (the Worker's
   when signed in, empty when not), and live events: the Brains tab refreshes with R. Unlike the
   Worker, the default brain can't be archived, since sessions need one. Checked with a
   signed-out bridge on its own state, and node.test.ts's "a brain made while the node runs".
7. **Moving off the Worker**: a signed-in user's plaintext memory imported once into the
   encrypted brain, then deleted from the Worker; `/privacy` changed in the same release.
   **Built 2026-11-04, deployed and run on the user's memory the same day** (pepper and work,
   into the account 1UeG7QJR…, from omni-laptop). Running it found two bugs, both fixed: notes
   over 64 KB didn't fit an op, so `LIMITS.op` is now 256 KB (wire.ts, here and in the Worker's
   clone), and the Worker's purge deleted vectors 500 at a time where Vectorize allows 100. `corkboard-bridge e2ee move-memory
   [--dry-run]` (bridge/node/move.ts, from e2ee.ts): makes the account (`init`) or publishes a
   `--local` one, starts the node (so the bridge mustn't be running one), and then freezes, copies,
   checks and purges. The Worker's `POST /api/memory/move` (user.ts's `memory_move`) freezes memory:
   `memoryOf` throws `Moved`, a 410 on the API, and on MCP the memory tools fail while the rest keep
   working. `GET /api/memory/move/:brain?table=` pages each brain's tables (the records, archived
   ones too, and "pepper"). The node takes notes with their times and versions (`importNote`, a
   newer one here wins), entries with ids from the Worker's (`importEntries`, `worker:<id>`, their
   days as they were), episodes with their ids and consolidated flags, `consolidated_sessions`
   and `rolled`, and each brain's settings onto its record. It checks that every note, entry and
   episode is here and every brain's changes are on the relay, and only then sends `POST
   .../done`, which purges each Memory DO (and the legacy `notes`) and marks the move done. A
   failure, or `--dry-run`, unfreezes it, and a second run copies only what's missing. Signed in
   with no account, a user stays on the Worker until they run it. The user's other machines join
   with `e2ee pair`. Brain records stay on the Worker for the fleet and brain tokens, so their
   settings can drift from the node's copies. Pepper, fleet slots and claude.ai get 410 for
   memory until a public node exists, and the Worker's brain counts read zero once it's purged.
   Checked with the Worker's test/move.test.ts and node.test.ts's "memory moved off the Worker",
   against a fake Worker.

8. **A leader node, reached through the relay.** (Decided 2026-11-04, the user's words: "users
   should be able to choose which node connected to their account is the leader, where the
   always-on stuff happens; if it's offline or there's no extra node, do the work locally on the
   client and sync when there can be a connection; instead of something like Tailscale Funnel,
   use Cloudflare, through our backend, by default.")
   - **Presence.** Each node of a signed-in account holds a socket to the account's `Nodes`
     Durable Object at the relay (`/e2ee/nodes/live`, its device token). `GET /e2ee/nodes` says
     which devices are connected and which is the leader; `PUT /e2ee/nodes/leader` { device |
     null } sets it (any device of the account). The leader is the relay's to know, since it
     routes by it; it's a device id, nothing secret.
   - **The tunnel.** `https://<relay>/n/<handle>/…` (handle: the first 22 characters of
     base64url(sha256(account id))) is forwarded, as `{ id, method, path, headers, body }`
     frames over that socket, to the leader when it's connected, else to the node that connected
     most recently, else 503. The node answers with its usual handler at the origin
     `<relay>/n/<handle>`, so OAuth, `/mcp`, the phone's API and the hooks' `/memory/*` all work
     there, and claude.ai, Pepper and fleet slots use that URL. RFC 8414's path-suffixed
     well-knowns (`/.well-known/oauth-authorization-server/n/<handle>`, …) are forwarded too.
     **The trade, said plainly:** TLS ends at Cloudflare, so the Worker sees these requests and
     answers in passing (it stores none of them). Replicas stay ciphertext. A user who wants TLS
     to end on the node sets `--origin` behind Funnel or Caddy, as before.
   - **The work.** What needs an always-on machine (serving those clients, the calendar, Pepper's
     timers, consolidating episodes that fleet slots and Pepper upload) lands on the leader
     because the tunnel routes there. A client's own work (its sessions' episodes, embedding
     what it wrote) is done where it is, as steps 3 to 5 have it, and syncs when it can. Handing
     a client's episodes to an online leader is 8b.
   - **Built 2026-11-04, the hosted Worker deployed the same day** (version 4aa27a2b; its
     wrangler migration v6, `export { Nodes }`, `tunnel()` ahead of the OAuth provider, so ahead
     of its own .well-known; the clone synced; 253/253). The user's account's tunnel is
     `https://portal.corkboard.fyi/n/tXwvWRd0Ce7CGvviZ6KtY_`, omni-laptop is its leader, connected
     after the dev bridge's restart; `/health`, both `.well-known` forms and the 401's
     `resource_metadata` answer through it. The
     site's /privacy paragraph on the tunnel is written but not deployed. relay/src/nodes.ts (`Nodes`, wrangler migration v2,
     ping auto-answered), routes.ts's `/e2ee/nodes[/leader|/live]` and `tunnel()` (index.ts calls
     it before `/e2ee/`), wire.ts's `NodesView`, `TunnelRequest/Response`, `nodeHandle`,
     `LIMITS.tunnel`/`tunnelMs`; lib/e2ee/relay.ts's `nodes`, `setLeader`, `serveTunnel` (the
     handler gets bare paths on `http://tunnel.invalid`, so it's given its origin); serve.ts's
     `startNode` connects it when signed in and `relay.nodes()` answers (an old relay's 404 just
     logs "no tunnel"), returning `tunnel { url, connected }`; oauth.ts's `ours` takes an origin
     with a path; the consent form posts to a relative `authorize`; `e2ee nodes` and `e2ee leader
     [this|DEVICE|none]`. Tests: relay.test.ts's "nodes and the tunnel" (26/26), node.test.ts's
     "the relay's tunnel" (69/69).
   - **8b, built 2026-11-04:** the node that leads is the one the tunnel goes to (serve.ts's
     `leads`, `relay.nodes()` asked once a minute; true offline, with no tunnel or none
     connected). Only it rolls up (the Consolidator's `leads`). Another node, once its episodes
     are quiet, hands them over instead of reading them (handoff.ts): the transcript gzipped
     and sealed with the brain's key (`Replica.key(epoch)`) as a blob, and an `episode:<id>`
     record with the blob, epoch, session and how far this node had read it; the episode is
     marked read here through its end. The leader, each tick, takes those records: opens the
     blob, `restoreThrough`s, `episodes.add`s, clears the record and deletes the blob
     (`Relay.deleteBlob`). Test: node.test.ts's "episodes handed to the leader" (70/70).
   - **8b, built 2026-11-04: grants on every node.** A new object kind `account` (keys.ts's
     KINDS), and the node keeps `account/oauth` (objects.ts's `accountObject`, in the index so
     a root rotation moves it). oauth.ts's `Shared`: clients, grants, refresh tokens and minted
     (`cli`) tokens are records `client:`/`grant:`/`token:<b64url hash>` with a `row` (null,
     cleared); codes, approvals and hourly access tokens stay per node, so a client whose node
     changed gets a 401 and refreshes. oauth.json stays the node's and lists what it has
     `shared`: a shared row gone from the file is cleared for all, one cleared elsewhere leaves
     the file, and a shared row is never given again, so `serve token`/`serve revoke` (other
     processes) still work. Test: "grants on every node of the account" (71/71).
   - **Built 2026-11-04:** the Settings tab's Devices (settings.lua's `M.device`, Settings.tsx):
     the address, copied with <CR> or [copy], and every device the relay has seen, its box the
     leader (again: none). The bridge answers `nodes_list`/`nodes_leader` (app.ts's `nodes`,
     boards.ts routes `nodes_*` to it, null with no tunnel). A node gives its cert's name on
     `/e2ee/nodes/live?name=`, and Nodes keeps a `devices` table (name, seen), so NodesView has
     `known`; without it (an older relay) a device is its id's first 8 characters.
   - **Built and deployed 2026-11-04: Pepper on the tunnel.** A minted grant may be a brain's
     (`serve token --scope assistant --brain NAME`, oauth.ts's `Grant.brain`): its caller's
     `brain` and `agent` are that brain, MCP's memory tools and `/memory/*` use it (another
     `?brain=` is 403), and it sees its goals. Test: "give a brain's own token its goals, and only
     its brain" (72/72). fleet/memory-hooks.nix takes `brain` (?brain=); fleet/pepper/guest.nix's
     hooks and a `corkboard-memory` MCP server go to the tunnel with /var/lib/pepper/memory-token
     (grant `pepper`, minted on omni-laptop, 10 years, copied in by hand). Deployed as
     rv7yy7wn…-pepper-cloud, built from HEAD plus only these changes (not the uncommitted "make
     no cards" hunk); `claude mcp list` in the guest shows both servers connected.
   - **Built 2026-11-04:** with a node, the bridge's `note_get`/`note_put` (usage.lua's reports)
     and `goals` (the day plan's box) go to its default brain (app.ts's `notes`, boards.ts), not
     the Worker's 410ing /api/notes and /api/goals. The goals parser is lib/model/goals.ts, which
     the Worker's cloud/src/goals.ts re-exports (clone synced, 256/256). Test: "the bridge's
     notes and goals, on the node" (73/73). **Still on the Worker:** record.ts's meeting notes
     (meetings are off by default).
   - **Built 2026-11-04:** memory-sync.ts (the work vault's 15-minute timer, failing on the 410)
     writes to this machine's node as the user: its address from session-mcp.json, and
     `<state>/node/owner-token`, an owner token app.ts keeps beside the sessions' (the soul is
     the owner's to write). The log goes to a new `POST /api/node/brains/:name/entries`, each
     entry's id from its key (`importEntries`, `key:<key>`), so new ones don't shift the rest,
     and one with the same time and text as one already there is skipped: move.ts's copies of
     the Worker's kept no keys, and all 3098 of the vault's match them. Notes synced live (78);
     the log waits for a bridge restart to have the route. Test: "adds a log written elsewhere
     once".

## Open

- **Episodes on a second device.** A session recorded on the laptop is consolidated only by the
  laptop; if it's off for a week, its episodes wait. Acceptable for now.
- **Pepper and claude.ai** read memory through the node, so they work while a node of the user's
  is up. That's the e2ee plan's trade, unchanged here.
- **The model.** bge-m3 matches the Worker's vectors but is about 570 MB; a small English model is
  ~35 MB. Start small; vectors are a cache, so changing it later only re-embeds.
