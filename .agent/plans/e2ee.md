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
2. *(Done, see below; Android under its own heading.)* Encrypted op log in the DOs alongside the current API; a client library (bridge, web, Android)
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

## Next: compaction, sharing, rotation (2026-11-02)

The wire additions, which every client (bridge, page, Android) speaks. All of
it is still ciphertext to the relay; what it learns new is who shares an
object with whom.

### Records are generic

`merge.ts`'s cards are records: an id, fields that are last-write-wins, and a
log that only grows. A board's records are its cards; a brain's are `brain`
(its settings), `note:<id>` (title, kind, body) and `entry:<id>` (at, day,
who, text). The op format doesn't change (`{ t: "card" | "log", card, ... }`;
`card` is the record id, `[\w.:-]{1,64}`).

### The index

Each account has one object of kind `index` (name `""`, its id and key
derived from the root like any other's): a record per object the account
has, id = the object's id, fields `{ kind, name, epoch, key? }`. `key` is
there when the object's key isn't derived from this root (a random key,
after sharing or rotation). Clients write an index record for each object
they first push; rotation and the node read it to find everything.

### Compaction: snapshots

A snapshot is the merged state (`BoardState`, stamps and all, so merging
continues) as one record, sealed under the object's key with AAD
`aad(object, "snapshot:<epoch>:<upTo>")`, `upTo` being the last `pos` it
covers.

- `POST /e2ee/log/:object/snapshot { upTo, epoch, nonce, ciphertext }`, owner
  only: the relay keeps it (in parts, under SQLite's 2 MB a value), deletes
  ops with `pos <= upTo` (keeping their ids, so a repeated push of one is
  still answered with its old position, not appended again) and counts the
  log's bytes again. `upTo` must be ≤ head and above the last snapshot's;
  a snapshot that raises the epoch must be at the head (409 otherwise: read
  and try again). `LIMITS.snapshot` = 16 MiB.
- `GET /e2ee/log/:object?since=` answers `{ ops, head, epoch, count, bytes }`
  and, when `since < snapshot.upTo`, `snapshot: { upTo, epoch, nonce,
  ciphertext }` with the ops after `upTo`. `count` and `bytes` are the ops
  kept since the snapshot. The socket's catch-up sends `{ snapshot }` first
  the same way.
- A replica given a snapshot past its cursor takes the snapshot's state,
  applies its own outbox's ops again (opened from the outbox), and carries
  on from `upTo`.
- The owner's clients compact when a read says more than 2000 ops or
  8 MiB are kept since the snapshot; the node does it as it syncs.

### Epochs

Every op carries `epoch` (NewOp/WireOp; absent = 0). The relay keeps the
log's epoch (raised only by a snapshot) and refuses a push under another
(409 `{ error, epoch }`); the client gets the key for the new epoch, opens
its outbox under the old one, seals it again under the new, and pushes.
Epoch 0 of an object whose index entry has no `key` uses the derived key.

### Sharing (brains first)

An object is shared by its owner with another account, read or write.

- An account's public keys: `GET /e2ee/accounts/:id` → `{ id, key, box,
  proof }`, `proof` being its signed creation and each rotation since, so a
  client checks the box key it seals to chains to the id it was given
  (which the person got from the member out of band: `e2ee status` shows it).
- Sharing first moves the object to a random key at the next epoch (a
  snapshot at the head under it) if it's still on its derived one, so the
  owner's rotation never has to change a shared object's id.
- A grant, signed by the owner's current account key:
  `{ v: 1, owner, object, member, role: "read" | "write", epoch, wrapped, at }`,
  `wrapped` being the base64url SHA-256 of the sealed box (to the member's
  box key) of `{ v: 1, owner, object, kind, name, epoch, key }`. Signing the
  hash stops the relay swapping in a sealed box of its own (they're
  anonymous). `POST /e2ee/grants { grant, sealed }`; a newer grant for the
  same member replaces the last.
- `DELETE /e2ee/grants/:object/:member` (owner) ends one; the owner then
  rekeys: a new random key, a snapshot at the head under the next epoch,
  and fresh grants to everyone left. What the removed member had, they keep.
- `GET /e2ee/grants?object=` (owner): the object's grants.
  `GET /e2ee/shared` (member): every grant to them, with its sealed box.
- A member reads and writes the owner's log at `/e2ee/log/:object?owner=<owner id>`;
  the relay checks the grant (and its role, for pushes). Snapshots and
  deletes are the owner's alone.
- Members' writes are only as trustworthy as the members: any of them could
  write as any device of theirs (ops aren't signed per device yet).

### Rotation

Revoking a device stops it syncing, but its copy of the root still opens
everything and still derives the account key, so it could certify a device
of its own. Rotation ends that.

- The relay knows an account by its first key forever (its **id**, which
  logs, blobs and grants are under) and by its **current key**, which certs
  must chain to. A rotation, signed by the current key:
  `{ v: 1, account (id), from (current key), to (new key), box (new box key), at }`.
- `POST /e2ee/rotate { rotation, certs, roots }`: `certs`, new certs for each
  device kept, signed by the new key; `roots`, per device kept, the new root
  sealed to its box key. The relay switches the key, ends every token, and
  keeps the bundle for each device to fetch.
- `POST /e2ee/rotated { account, device }` → `{ rotations, cert, root }`
  for a device whose cert no longer counts: it checks each rotation is
  signed by the key before it (from the one it knows), opens the root, and
  checks `accountKeys(root)`'s key is the last rotation's `to`. Then it signs
  in with the new cert.
- The rotating device makes the new root (kept on disk before anything
  else, so a crash can be resumed); for each object in the index, writes its
  merged state into the new object (a new derived id; for a shared object
  the same id with a new random key at the next epoch, and its grants
  sealed again); writes the new index; posts the rotation; reads the old
  logs once more for anything written meanwhile; deletes them
  (`DELETE /e2ee/log/:object`); and shows the new recovery phrase. The old
  one no longer works.
- A device that had changes queued when the rotation came opens them under
  the old key and queues them again on the new object.

### Built (2026-11-02)

lib/e2ee (`sharing.ts`, the replica's snapshots and epochs, the relay client's routes), the
Worker (`cloud/src/e2ee.ts`, `log.ts`, `registry.ts`), Android's `Sharing.kt`, the node's use of
the index, and the CLI: `corkboard-bridge e2ee share|unshare|shared|compact|rotate|rotated`.
lib is tested against the Worker under miniflare (`cloud/test/e2ee.test.ts`), including a
rotation with a shared object. What the relay settled that clients rely on:

- `/e2ee/token` answers `{ token, expires, account }`, account being the id. A cert signed by a
  key the account had before gets 401, pointing at `POST /e2ee/rotated`. Clients take the
  account id from the token, never from a cert.
- `GET /e2ee/accounts/:id` wants a token. A revocation must be signed by the current key.
- A snapshot may repeat the last one's `upTo` if it raises the epoch (rekeying right after a
  share or a rotation would otherwise be refused forever).
- `DELETE /e2ee/log/:object` drops the object's grants too; an ungrant closes the member's
  sockets. There's no ungrant statement: the owner's token is enough.
- A rotation's grants are signed by the new key, so they're posted after `/e2ee/rotate`.

Still to do, or known gaps:

- An account made before creations were kept is served with `creation: null`, so its keys don't
  chain and nothing can be shared with it until it proves them again; nothing does that yet.
- When a member rotates, the grants it holds stay sealed to its old box key: its owners have to
  grant again, and no client notices that it should.
- No route lists an account's devices, so the CLI's rotate keeps only the machine it runs on;
  the others pair again. A crash mid-rotation leaves `rotating.json`, which nothing resumes from.
- A device left out of a rotation keeps the sockets it has open on shared logs.
- A 16 MiB snapshot is about a 21 MB WebSocket message; nobody has checked that against
  Cloudflare's limit.
- Members' writes aren't signed per device.
- Everything has run only under miniflare; none of it is deployed, and the CLI's new commands
  haven't run against a relay.

## Settled: claude.ai and the node

Checked 2026-11-02 against Anthropic's connector docs and the live client metadata.

- claude.ai takes any HTTPS URL as a custom connector, on every plan (Free is limited to one
  custom connector; on Team and Enterprise an Owner adds it and each member connects). Web,
  desktop and mobile share one client, and nothing about the server is hard-coded: the node's
  own origin works as its own authorization server.
- Requests come from Anthropic's servers, `160.79.104.0/21`, never from the user's device, so
  the node must be on the public internet; a tailnet-only address fails. Before connecting,
  Claude resolves the hostname through public DNS and refuses it unless every address is
  globally routable: no `10/8`, `172.16/12`, `192.168/16`, CGNAT `100.64/10` (tailnet
  addresses), loopback or link-local, and it needs an `A` record (connectors are IPv4-only).
  The docs name no port or certificate rule beyond HTTPS; assume a publicly trusted cert (Let's
  Encrypt is fine, self-signed isn't) and that a non-443 port works but is untested.
- The URL must not redirect to another host: Claude drops `Authorization` on the redirect.
- Transport: Streamable HTTP (legacy HTTP+SSE still works). A tool call gets 240 s and a result
  up to about 150,000 characters. OAuth discovery, registration and token calls get 10 s,
  refresh 30 s. Claude caches discovery metadata per URL for about five minutes.
- Tailscale Funnel fits: TLS ends in tailscaled on the node and the relay only proxies TCP
  ("cannot decrypt"); ports 443, 8443 or 10000; hostname `<device>.<tailnet>.ts.net`, where the
  tailnet name is `tail<hex>` or a picked random pair, not free text; all plans, including the
  free one; beta, with unpublished bandwidth limits (fine for MCP, not for media). Nothing
  documents an idle timeout on long streams; send SSE keepalives anyway.

What the node's OAuth and `/mcp` must do (the Worker's workers-oauth-provider setup already does
all of it, with DCR and CIMD both on, and works with claude.ai today):

- Answer an unauthenticated `/mcp` request with `401` and
  `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource", scope="assistant"`.
  A tool error inside a `200` doesn't start sign-in.
- Serve RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp`, with `resource` equal to the URL the user typed,
  path included (`https://<host>/mcp`; the Worker gives its bare origin, which Claude's docs say
  not to rely on), and the node's origin first in `authorization_servers` (Claude reads only the
  first).
- Serve RFC 8414 metadata at `/.well-known/oauth-authorization-server` with `/authorize`,
  `/token`, `code_challenge_methods_supported: ["S256"]`,
  `client_id_metadata_document_supported: true` and `"none"` in
  `token_endpoint_auth_methods_supported`. Without both of the last two Claude falls back to DCR,
  so keep `/register` (RFC 7591, JSON body) too.
- CIMD: claude.ai's `client_id` is `https://claude.ai/oauth/mcp-oauth-client-metadata`, a public
  client (`token_endpoint_auth_method: "none"`) whose only redirect URI is
  `https://claude.ai/api/mcp/auth_callback`. Claude Code's is
  `https://claude.ai/oauth/claude-code-client-metadata`, redirecting to `http://localhost/callback`
  and `http://127.0.0.1/callback` on any port, so match loopback redirects ignoring the port. The
  node fetches these documents itself, so it needs outbound HTTPS and must refuse to fetch
  non-public addresses (the Worker gets this from `global_fetch_strictly_public`).
- PKCE S256 on every request; honour the RFC 8707 `resource` parameter and bind tokens to it
  (compare canonical forms). `/token` takes form-urlencoded bodies, answers `invalid_grant` for a
  dead refresh token, and rotates refresh tokens. Claude refreshes on `401` and up to five minutes
  before expiry. Claude adds `offline_access` only if the AS lists it; no need to.
- The consent page shows the redirect URI's host (claude.ai), as the Worker's does.
- The connector dialog also takes a hand-entered client ID and optional secret ("Use your own
  OAuth client"), so a node could skip CIMD and DCR, but nothing requires it.

Sources:
[authentication](https://claude.com/docs/connectors/building/authentication.md),
[troubleshooting](https://claude.com/docs/connectors/building/troubleshooting.md),
[lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication.md),
[build overview (transport, limits)](https://claude.com/docs/connectors/building/index.md),
[add a connector by URL](https://claude.com/docs/connectors/custom/add-unlisted.md),
[help center: custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[Anthropic IP addresses](https://platform.claude.com/docs/en/api/ip-addresses),
[claude.ai client metadata](https://claude.ai/oauth/mcp-oauth-client-metadata),
[MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel),
[tailnet name](https://tailscale.com/kb/1217/tailnet-name).

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
## Android (2026-11-02)

The phone is a device of its own: it pairs, keeps the root, and reads and writes the relay
directly, with no node. The rest of the app goes on talking to the plaintext API.

- **`app.corkboard.e2ee`** (android/app/src/main/java/app/corkboard/e2ee/) is lib/e2ee in Kotlin, on
  libsodium through lazysodium-android 5.1 (5.2 is built for Java 21, which the JVM tests don't
  have): `Wire.kt` has every signed layout, the JSON types and the limits, and is where the
  newer wire changes if it shifts; `Crypto.kt` the primitives (HKDF and SHA-256 are the JDK's);
  `Keys.kt` keys, certs, records, blobs, sealed boxes and the phrase (the BIP39 list is
  `assets/bip39-english.txt`); `Pairing.kt`, `Merge.kt` (JS's key order and all, so `cards()` is
  the same JSON), `Sync.kt` (the replica, with snapshots, epochs, compaction and rekeying),
  `Relay.kt` (okhttp; the socket reconnects from its cursor), `Sharing.kt` (the index, grants
  both ways, `currentKey` checking an account's proof, rotation and catching up on one).
- **Byte for byte**: `bun android/e2ee-vectors.ts` has lib/e2ee make keys, ids, signed bytes,
  signatures, short codes, a delivery, records, blobs, boxes, phrases, merges, a TS replica's log
  and snapshot, and a brain's ops at epoch 1 from a seeded random, into
  `app/src/test/resources/e2ee-vectors.json`; `E2eeVectorsTest` checks the Kotlin against it
  and `E2eeFlowsTest` pairs Kotlin with Kotlin and compacts and rekeys under a member
  (`gradle -p android test`). Grants, ungrants and rotations use the labels lib/e2ee is getting
  (`grant`, `ungrant`, `rotation`); the script takes lib/e2ee's own once it exports them.
- **The keystore**: an AES-GCM key in the Android Keystore (StrongBox where there is one, no
  user auth yet) seals each file under `files/e2ee/`: the root, the device's keys and cert, the
  token, the typed board keys, and every replica.
- **The screens**: brains → encrypted (and a row in setup): pair this phone (the code, then the
  six digits, yes or no), the account and device, the boards (the index's, or a key typed in,
  written to the index once it has cards), a board's cards by status, a card's title and status
  to change and its log to add to, and what's shared with this account (brains open to their
  notes and entries; a shared board as a board, read-only unless the grant says write).

Still to do:

- Run against a real relay or phone: the library is checked against lib/e2ee's vectors, and lib
  against the Worker under miniflare, but the phone has never talked to the Worker.
- lazysodium-android 5.1's libsodium is 4 KB-aligned, so it won't load on a 16 KB-page phone.
- Recovering from the phrase, approving another device, revoking, sharing and rotating from the
  phone: the library has them, the screens don't. No QR yet.

## Open questions

- Whether the phone talks to the node directly or through the relay (the relay would see only
  ciphertext if the phone and node encrypt between themselves).
- The trust boundary of the web page: a page served from our domain can be changed to steal keys.
  Only the signed desktop app and reproducible Nix builds are trustworthy clients; the portal
  should say so, or load only through the app.
