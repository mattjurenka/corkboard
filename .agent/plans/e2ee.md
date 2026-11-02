# End-to-end encrypted corkboard: the Worker stores ciphertext, users' own nodes read it

**Written:** 2026-11-02 · **Decided:** users shouldn't have to trust Matthew or Google with their
data. The Worker becomes a relay that stores and forwards ciphertext it can't read. Keys live on the
user's devices. Everything that needs plaintext (the claude.ai connector, the phone's API, memory
search, consolidation, calendar writes, Pepper) runs on a **node**: the bridge, headless, on a
machine the user runs. The phone and claude.ai work only while that node is up. A hosted node on
our fleet comes later, as an opt-in that means trusting us.

Not considered further: the Internet Computer (canister data is readable by node operators, so
it'd be client-side encryption plus a chain for nothing) and Holochain (immature on Windows and
mobile, and still needs always-on peers and encryption).

```
laptop app ─┐                         ┌─ phone app ──https──┐
            │  ciphertext ops          │                      ▼
            ├──────────────▶ Worker ◀──┤            node (user's machine)
  node ─────┘   (relay)      stores,   │            bridge --serve: keys, plaintext,
                             forwards, └─ claude.ai ──https/oauth──▶ /mcp, memory, calendar
                             wakes
```

---

## Identity and keys

- **Account key:** a random 32-byte root made on the first device. The Worker knows the account by
  a public signing key, not by a Google sub. Requests are signed or carry a token minted after a
  signed challenge.
- **Sign-in:** passkeys. The WebAuthn PRF extension wraps the root on devices that support it;
  elsewhere the root sits in the OS keychain (Electron safeStorage, Android Keystore).
- **Recovery phrase:** shown once at account creation. Losing every device and the phrase means
  losing the data. That's the point.
- **New devices pair** with one that has the root: a QR code or short code, with a key exchange
  over the relay. This replaces "sign in as owner on every machine" and the machine token.
- **Hierarchy:** root → one key per board, brain and memory → records. Board keys are wrapped to
  each member's public key, so collaborators later are a key-wrapping change, not a data migration.
- **Crypto:** libsodium (XChaCha20-Poly1305 for records, X25519 sealed boxes for wrapping, Ed25519
  for signing). No home-made primitives.

## The relay (the Worker)

- One append-only log of encrypted ops per board, brain and memory, in the same Durable Objects
  keyed per account. Ops: `{id, device, seq, ciphertext, nonce}`. The server orders them and fans
  them out over WebSockets. It doesn't interpret them.
- Clients merge. Cards are small records, so last-write-wins per field with a Lamport clock is
  enough to start; Automerge if card bodies need concurrent editing.
- Attachments: encrypted on the device, uploaded to R2 under opaque ids.
- The registry and invites stay as quotas and abuse control on the relay.
- The protocol is published, so anyone can run a relay (this Worker, a small Bun server).
- Metadata still leaks (who syncs, when, how much). Accepted.

## The node

- `corkboard-bridge serve`: the compiled bridge with no window, holding the account root (paired
  like any device). It keeps decrypted replicas of the user's boards and serves:
  - **`/mcp` for claude.ai**, with its own OAuth server (reusing the Worker's
    workers-oauth-provider flow, ported to Bun). The user adds the node's address as a connector.
  - **an API for the phone.** The phone holds its own keys and can read boards directly from the
    relay; the node is needed for search, Pepper and agents.
  - **memory:** embeddings on the node (bge-m3 or a smaller model through onnxruntime, which the
    bridge already ships for speech), consolidation, alarms.
  - **calendar:** the Google refresh token lives on the node; it writes the accepted day plan.
  - **Pepper and agents:** run on or are dispatched by the node; fleet hosts get keys scoped to the
    card or brain they work on.
- **Reachability:** needs a public HTTPS address with TLS ending on the node. Supported:
  - Tailscale Funnel;
  - Caddy with Let's Encrypt on a VPS;
  - later, a corkboard relay that forwards raw TLS by hostname (`<user>.node.corkboard.fyi`).
  
  Cloudflare Tunnel doesn't count: it ends TLS at Cloudflare.
- **When the node is down:** the phone shows boards from its own replica, read-only for anything
  needing the node; claude.ai's connector fails. The relay tells clients whether the node is
  connected.

## What moves out of the Worker

| Today in the Worker | Goes to |
|---|---|
| `/mcp` (cards, notes, memory, brains, plans, spawns) | the node; Claude Code uses the local bridge's `mcp` subcommand |
| Workers AI embeddings and Vectorize | the node |
| Memory DO alarms and consolidation | the node |
| Calendar writes on plan accept | the node |
| `/api/git` proxy | the device, talking to the forge directly |
| Holds (and `HOLDS_KEY`) | encrypted on the device like everything else |
| Google sign-in | gone; Google is only a calendar connector held by the node |

## Order

1. *(Done, see below.)* Keys: account root, passkey and keychain wrapping, recovery phrase, device pairing. A
   signed-challenge sign-in to the Worker alongside Google.
2. *(Done but Android, see below.)* Encrypted op log in the DOs alongside the current API; a client library (bridge, web, Android)
   that encrypts, syncs and merges.
3. *(The node is built, see below; Claude Code isn't moved yet.)* `bridge serve` as the node:
   replicas, `/mcp` with its own OAuth, the phone API, memory, calendar. Move Claude Code onto
   the local MCP.
4. Migration: each account's first node downloads its plaintext, encrypts it, re-uploads it; then
   the Worker deletes the plaintext and the server-side features are turned off for that account.
5. Reachability helpers (Funnel setup in the app, the TLS-forwarding relay), a Docker image and a
   VPS image for the node.
6. Later: hosted nodes on our fleet, clearly labelled as trusting us.

## Done: steps 1 and 2 (2026-11-02)

Alongside everything else: Google sign-in and the plaintext API are untouched, and nothing uses the
encrypted side yet but `corkboard-bridge e2ee`.

- **`lib/e2ee/`**, shared by the bridge, the page and the Worker's tests (`bun run test:e2ee`):
  `keys.ts` (root → HKDF-SHA256 per label: account Ed25519 and X25519 keys, each object's key and
  its opaque 128-bit id, so the relay never sees a board's name), `record.ts` (XChaCha20-Poly1305,
  AAD binding object id and op id; blobs bound to their id), `box.ts` (sealed boxes),
  `phrase.ts` (BIP39, 24 words), `device.ts` (device keys, certs, revocations, the signed
  challenge), `pairing.ts`, `merge.ts`, `sync.ts` (the replica), `relay.ts` (the HTTP client).
  `wire.ts` has the signed byte layouts and limits with no crypto library, and is all of it the
  Worker imports.
- **The relay** (`cloud/src/e2ee.ts`, `log.ts`, `mailbox.ts`, under `/e2ee/*`): accounts in the
  Registry, keyed by account key, made with an invite or by an admin (`POST /api/e2ee/accounts`;
  `GET/PATCH /api/admin/e2ee` to list and disable); `/e2ee/challenge` → device signs → `/e2ee/token`
  (`cbe_…`, 24 h, hashed in the Registry); revocations signed by the account key, which also kill the
  device's tokens; a `Log` DO per `<account>/<object>` (append-only, server order `pos`, idempotent
  by op id, `since` catch-up, hibernating WebSocket fan-out, size limits); a `Mailbox` DO per pairing
  code; encrypted blobs in `MEDIA` under `e2ee/<account>/<id>`. Wrangler migration `v5`.
- **The bridge**: `corkboard-bridge e2ee init|recover|pair|approve|push-board|pull-board|status|revoke`
  (`bridge/e2ee.ts`); keys in `<state>/e2ee/` (`bridge/keystore.ts`).
- **The page**: `web/src/e2ee/keystore.ts` keeps the root in IndexedDB under a passkey's PRF output
  where supported, else a non-extractable WebCrypto key. Untested in a real browser; nothing calls it.

### What changed from the plan above

- **@noble and @scure instead of libsodium.js.** libsodium.js instantiates its wasm from bytes at run
  time, which Workers forbid, and its ESM build trips bundlers; @noble/curves, hashes and ciphers
  and @scure/bip39 are audited, pure JS, and work the same in `bun build --compile`, browsers and
  workerd. The constructions are libsodium's, byte for byte (`crypto_aead_xchacha20poly1305_ietf`,
  Ed25519, and `crypto_box_seal`, checked against libsodium's own output both ways), so the
  Android app can use libsodium (lazysodium) directly.
- **The Worker checks signatures with WebCrypto's Ed25519**, so it bundles no crypto library.
- **Logs are a new `Log` Durable Object**, not tables in the existing per-user ones: an account is
  a key, not a sub, and a log per object keeps each one's socket fan-out and size limit its own.
- **Pairing doesn't use a sealed box for the root.** A sealed box is anonymous, so a relay could
  seal a root of its own to the new device. Instead: the approver commits to an ephemeral X25519
  key before it sees the new device's, the new device waits for that commitment before joining,
  both show six digits hashed from the transcript (code, both keys, the device key), and the root
  travels in a record keyed by X25519(approver, new device) with the transcript as salt and AAD.
  A relay in the middle gets one 1-in-10^6 guess per attempt. A QR (`corkboard-pair:1:<code>:<box>`)
  lets the approver check the new device's key outright; the six digits are still compared.
  Sealed boxes are there for wrapping board keys to members, later.
- **Board keys are derived from the root** (HKDF, `object key board\0<key>`), not random and wrapped:
  a device with the root needs nothing else, and the derived key can still be wrapped to a
  collaborator without giving them the root.
- **A device's `seq` is informational.** The relay records it but doesn't enforce it; readers can use
  gaps in a device's seq to notice a relay withholding ops (not done yet). Order is the relay's `pos`.
- **Merge**: per field, the write with the highest (Lamport clock, device, op id); logs are a set by
  op id read in that order. An op whose inner device differs from the relay's label, or that doesn't
  open, is skipped and listed in the replica's `rejected`.
- **The bridge's keychain is a seam with one implementation, a file** (`<state>/e2ee/kek`, 0600)
  beside `root.json`; `--passphrase` (or `CORKBOARD_E2EE_PASSPHRASE`) uses scrypt (N=2^16) instead.
  libsecret, the macOS keychain, DPAPI and Electron's safeStorage go behind `Keychain`.

### Still to do, or known gaps

- Rate limits on the unauthenticated `/e2ee/pair` (makes a DO) and `/e2ee/challenge` (a Registry
  row, swept as they expire). The Registry is one object for the whole Worker: every token check
  goes through it (cached 30 s per isolate, so a revocation or disable elsewhere takes up to that).
- Members and sharing (board keys wrapped to other accounts' box keys); key rotation after a
  revocation (a revoked device still knows the root: revoking stops it syncing, not reading what
  it had). Rotation means a new root and re-encrypting, which the log's design allows but nothing does.
- Log compaction (snapshots) — logs only grow, to 64 MiB each.
- The bridge CLI has been run compiled up to the relay call; its whole flows have been tested only
  through the library against the Worker in vitest, not as a CLI against a running Worker.
- Attachments: the blob routes and `sealBlob` exist; no op type names one yet.

## Done: step 3, the node (2026-11-02)

`corkboard-bridge serve` (`bridge/node/`), headless, alongside everything else: the Worker's
plaintext `/mcp` is untouched, and the node serves only objects that are already encrypted
(`e2ee push-board`).

- **Replicas** (`replicas.ts`): this machine signs in as its device (the keystore, as `e2ee`
  does; a passphrase from `CORKBOARD_E2EE_PASSPHRASE`), opens a `Replica` per object, kept in
  `<state>/e2ee/replicas/` beside the CLI's, pulls each, follows each log's socket, pushes each
  change behind the caller (again every 10 s until it goes), and syncs everything every five
  minutes in case a socket died quietly.
- **Which objects** (`objects.ts`): `--board KEY` and `--brain NAME`, repeated, and
  `<state>/node/config.json`'s `boards` and `brains`; ids and keys derived from the root. This
  is the one file that reads the index once there is one: it answers
  `{ kind, name, object, key, owner? }` and nothing else.
- **Records** (`data.ts`): a board's are cards in the Worker's `Card` shape (`cloud/src/cards.ts`,
  imported, as are `plans.ts` and `dates.ts`); a brain's are `brain`, `note:<id>`
  `{ kind, title, body, created, updated, version, path? }` and `entry:<id>`
  `{ at, day, who, text }`, an entry's id being base36 time and random. `merge.ts` here still
  refuses a colon in a record id, so `objects.ts` asks it, and uses `note.<id>` and `entry.<id>`
  until it doesn't. A note's version counts this node's writes, for `note_write`'s check only.
- **`/mcp`** (`mcp.ts`): the Worker's tools and descriptions for cards (`list_boards`,
  `list_cards`, `read_card`, `next_card`, `claim_card`, `release_card`, `log`, `block`,
  `request_user_action`, `submit_for_review`, `handoff`, `update_card`, `archive_card`,
  `write_description`, `create_card`) and memory (`notes_search`, `note_read`, `note_write`,
  `note_append`, `memory_context`, `memory_recall`, `memory_remember`, `memory_log`,
  `memory_grep`, `brain_list`, `brain_read`), in the default brain (its settings say `default`,
  else the first given). Stateless Streamable HTTP answered with JSON: every tool answers from
  local state at once, so there's no stream to keep alive yet.
- **Search** (`search.ts`): bun:sqlite FTS5 in memory, made again from a brain's replica when
  it has changed since the last search; `recall` is memory.ts's rank fusion of words, the day the
  question names and an `Embedder` seam that nothing fills yet.
- **OAuth** (`oauth.ts`), per "Settled" above: protected resource metadata at both paths
  (`resource` `<origin>/mcp`), AS metadata, DCR, CIMD (fetched only from public addresses, 10 s,
  no redirects, kept an hour), `/authorize` with S256 only, loopback redirects matched on any
  port, `resource` checked in canonical form and bound to the grant, `/token` (form or JSON;
  codes spent even when the exchange fails; refresh tokens rotated, a dead one `invalid_grant`),
  the 401 with `resource_metadata` and `scope="assistant"`. Scopes `assistant` (claude.ai's;
  can't write the soul) and `owner`. Access tokens (`cbn_`) last an hour, refresh tokens (`cbr_`)
  30 idle days; all of it in `<state>/node/oauth.json` (0600), tokens and codes by SHA-256.
- **Consent** is proof of owning the node: a one-time approval code (8 characters of Crockford
  base32, ten minutes) from `corkboard-bridge e2ee approve-connector`, or printed by `serve` as
  it starts. Compared by hash in constant time; five wrong codes in 15 minutes and the page
  takes none until they age out. The page shows the client's name and the redirect's host.
- **The phone's API** at `/api/node/*` (`server.ts` lists it): status, boards with cards, card
  create/update/log, brains, notes, recall, entries, remember, and `POST calendar`. A bearer from
  the same OAuth server, or `corkboard-bridge serve token [--name] [--days] [--scope]` (printed
  once; `serve grants` and `serve revoke GRANT` to see and end them). `/health` needs none.
- **Calendar** (`calendar.ts`): `cloud/src/calendar.ts`'s write, with the refresh token in
  `<state>/node/calendar.json`. `serve calendar-login --client-id --client-secret` runs Google's
  consent for a desktop OAuth client of the user's own back to a loopback port and makes a
  "Claude" calendar unless `--calendar` names one; `--file` takes one made elsewhere. A plan is
  written when the phone posts it to `/api/node/calendar` after accepting.
- Tests: `bun run test:e2ee` takes in `bridge/node/node.test.ts` (DCR → consent → PKCE → token →
  refresh and rotation → `/mcp`; the tools over replicas on an in-memory relay, read back by
  another device; the phone's API; the calendar against a fake Google). `bridge/node` is in the
  root `tsconfig.json`.

### Running it

```
corkboard-bridge e2ee push-board KEY          # once per board, from a device with the root
corkboard-bridge serve --board KEY --brain assistant --origin https://NAME
```

It listens on `127.0.0.1:8787`. claude.ai connects from Anthropic's servers (`160.79.104.0/21`),
over IPv4, to a name in public DNS whose every address is globally routable, with no redirect
to another host. So a tailnet-only address won't do:

- **Tailscale Funnel**: `tailscale funnel --bg 8787`, and `--origin https://<device>.<tailnet>.ts.net`.
  TLS ends in tailscaled on the node.
- **Caddy on a VPS** (the node on the VPS, or reached over the tailnet from it, TLS ending in
  Caddy): `NAME { reverse_proxy 127.0.0.1:8787 }`, and `--origin https://NAME`.

Without `--origin` the node names itself from the request's `Host` (https unless it's this
machine), which works behind both but is better given. Then in claude.ai: add a custom connector
with `https://NAME/mcp`, and when the node's page asks, type the code from
`corkboard-bridge e2ee approve-connector`.

### Still to do, or known gaps

- Not run against a real relay or with claude.ai yet: everything is tested through the
  in-memory transport and requests to the handler.
- Objects come from flags until the index lands; shared objects (`owner`), epochs, snapshots
  and compaction are the adapter's and the replica's to take up when `lib/e2ee` has them. The
  node doesn't compact.
- Two devices making a card at once can pick the same `TASK-n` and merge into one card; note
  appends from two places at once keep one (a body is one last-write-wins field).
- Not on the node yet: attachments, `create_board`, day plans (`plan_read`, `plan_propose`) and
  the chat, which need record types of their own; spawns and agents.
- Memory consolidation, alarms, embeddings and Pepper are out of this step. The seams: the
  `Embedder` in `search.ts`, and `Replicas.onChange`, which is what a consolidator or Pepper
  would follow.
- The calendar is written only when the phone posts the plan; once plans are records, the node
  can write one when it sees an accept.
- A CIMD host's DNS could change between the check and the fetch (rebinding).
- SSE keepalives: nothing streams yet. A tool that takes long (a calendar write, recall by
  meaning) should answer as SSE with comments as keepalives.

## Open questions

- How claude.ai's connector handles a node with a self-chosen hostname, and whether its OAuth
  client (CIMD) works against an arbitrary origin. Check before step 3.
- Whether the phone talks to the node directly or through the relay (the relay would see only
  ciphertext if the phone and node encrypt between themselves).
- The trust boundary of the web page: a page served from our domain can be changed to steal keys.
  Only the signed desktop app and reproducible Nix builds are trustworthy clients; the portal
  should say so, or load only through the app.
