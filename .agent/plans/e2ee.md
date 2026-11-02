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

1. Keys: account root, passkey and keychain wrapping, recovery phrase, device pairing. A
   signed-challenge sign-in to the Worker alongside Google.
2. Encrypted op log in the DOs alongside the current API; a client library (bridge, web, Android)
   that encrypts, syncs and merges.
3. `bridge serve` as the node: replicas, `/mcp` with its own OAuth, the phone API, memory,
   calendar. Move Claude Code onto the local MCP.
4. Migration: each account's first node downloads its plaintext, encrypts it, re-uploads it; then
   the Worker deletes the plaintext and the server-side features are turned off for that account.
5. Reachability helpers (Funnel setup in the app, the TLS-forwarding relay), a Docker image and a
   VPS image for the node.
6. Later: hosted nodes on our fleet, clearly labelled as trusting us.

## Open questions

- How claude.ai's connector handles a node with a self-chosen hostname, and whether its OAuth
  client (CIMD) works against an arbitrary origin. Check before step 3.
- Whether the phone talks to the node directly or through the relay (the relay would see only
  ciphertext if the phone and node encrypt between themselves).
- The trust boundary of the web page: a page served from our domain can be changed to steal keys.
  Only the signed desktop app and reproducible Nix builds are trustworthy clients; the portal
  should say so, or load only through the app.
