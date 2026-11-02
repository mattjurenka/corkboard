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
3. `bridge serve` as the node: replicas, `/mcp` with its own OAuth, the phone API, memory,
   calendar. Move Claude Code onto the local MCP.
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

- Run against a real relay: everything has been tested against vectors and fakes, not the Worker.
- The relay's new routes (snapshots, `?owner=`, grants, `/e2ee/shared`, accounts, rotate) are as
  the plan words them; the shapes of `/e2ee/shared` and `/e2ee/rotate`'s `roots` are guesses.
- An account id for a device paired after a rotation: its cert names the current key, not the
  id, and the phone takes the cert's.
- lazysodium-android 5.1's libsodium is 4 KB-aligned, so it won't load on a 16 KB-page phone.
- Recovering from the phrase, approving another device, revoking, sharing and rotating from the
  phone: the library has them, the screens don't. No QR yet.

## Open questions

- How claude.ai's connector handles a node with a self-chosen hostname, and whether its OAuth
  client (CIMD) works against an arbitrary origin. Check before step 3.
- Whether the phone talks to the node directly or through the relay (the relay would see only
  ciphertext if the phone and node encrypt between themselves).
- The trust boundary of the web page: a page served from our domain can be changed to steal keys.
  Only the signed desktop app and reproducible Nix builds are trustworthy clients; the portal
  should say so, or load only through the app.
