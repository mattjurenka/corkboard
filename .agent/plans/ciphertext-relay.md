# The Worker relays only ciphertext: sessions, the tunnel and the fleet

**Written:** 2026-11-05 · **Decided:** the Worker should be a ciphertext relay only (the user, on
learning the phone reaches sessions without pairing). e2ee.md moved the stored data (boards,
memory, plans and chat). This plan covers what still passes through the Worker in plaintext.

## What the Worker still reads (2026-11-05)

Paths: W = corkboard-cloud/cloud/src, C = corkboard.

- **Sessions.** Everything under `/api/sessions*` runs through the User DO (W/user.ts:615-802),
  between the bridge's `/api/live?bridge=` socket (C/bridge/sessions.ts `serve()`) and whoever is
  watching: the phone (Cloud.kt, Sessions.kt), Neovim's and the web page's `fleet_follow` /
  `fleet_terminal` / `fleet_say` (C/bridge/cloud-session.ts), and fleetd's VM sessions. The DO
  *keeps* each machine's session list (project, name, state, `detail` = the question Claude is
  asking, card, persona) and fans it out as `bridge` events. It passes on, without keeping:
  - the screen (300 lines);
  - what's typed and keys (`say`);
  - the whole conversation (`attach` items: your text, Claude's, tool calls, questions, results);
  - raw terminal bytes and keystrokes (`attach?terminal`);
  - speech text and the PCM it becomes.
  The phone needs only the Worker login for all of it, which is why it works unpaired.
- **The node tunnel** (`/n/<handle>`, C/relay/src/routes.ts `tunnel()` → nodes.ts `forward()`).
  TLS ends at Cloudflare. The relay reads each request whole, bearer included, as JSON, and
  sends it to the node's socket (nodes.ts:9-10: "plaintext here in passing"). That covers the
  portal, the phone's node API, claude.ai's `/mcp` and its OAuth, and fleetd's owner token.
  Each request and its answer are buffered whole (17 MB, 60 s). WebSockets get a 501, and
  there's no SSE.
- **The fleet.**
  - Each spawn's `task` (≤20000) and `result` (≤8000) are stored, `node: true` spawns too.
    fleetd posts the result to both the node's card and the Worker.
  - The environments' manifests (hosts, slots, VM addresses, egress lists) are kept and sent as
    `fleet` events.
  - Holds are sealed with the Worker's own `HOLDS_KEY`, so the Worker can open them. They reach
    a slot as `secrets` at the claim.
- **Smaller things.**
  - The calendar's Google refresh token, kept on purpose (local-plans.md, Decide).
  - Brains' records on the Worker (persona, account).
  - Meeting transcripts PUT to `/api/notes/meeting-*` (C/bridge/record.ts:299). This fails
    once memory has moved.
  - Workspace tickets (`{user, bridge, board, node}`, 120 s).
  - The plaintext features kept for accounts that haven't moved.

Metadata stays visible, as e2ee.md accepts: who connects, when, how much, which devices.

## The shape: a sealed channel through the relay

```
phone / page / Neovim ──wss /e2ee/channel──▶ relay ──node's socket──▶ device (node, bridge, fleetd)
        └──────────── X25519 handshake on device certs, XChaCha20 frames ────────────┘
```

- **Endpoints are devices.** Any paired device can open a channel to another of the account's
  connected devices: `GET /e2ee/channel?to=<device>` (a WebSocket, the relay token as today).
  The node's tunnel socket learns to carry channels as well as tunnel requests. The relay pairs
  the two ends and forwards binary frames. It reads only the routing header (a channel id).
- **Handshake** (lib/e2ee/channel.ts). Each side shows its device cert, and the other side
  checks it against the account key and the revocations (`checkCert`), current key after a
  rotation included. A Noise-style XX exchange runs over the certs' box keys plus ephemeral
  keys, and each side signs the transcript with its device key. HKDF gives one key per
  direction. Frames are XChaCha20-Poly1305 with counter nonces, and a replayed or reordered
  frame drops the channel. A relay that substitutes a key fails the cert check, so it can't sit
  in the middle. Built from libsodium as e2ee.md says; no home-made primitives.
- **Inside: streams.** One channel multiplexes numbered streams, each one of:
  - an HTTP request and answer, with the answer's body streamed;
  - a long-lived duplex stream, for what WebSockets and SSE do today.
  The node's HTTP (`/api/node/*`, `/app/events`, the phone's API) is served unchanged over
  these streams, the same as on loopback. This also lifts the tunnel's buffering and 60 s
  limits.
- **Sessions are a stream protocol.** Each machine's bridge (and fleetd for its VMs) answers
  `sessions` (the list, then changes), `screen`, `say`, `speech` and `attach[?terminal]` on its
  own channel. This is the protocol sessions.ts already speaks over `/api/live`, carried
  sealed. The session list stops being stored: a watcher opens a channel to each connected
  device the relay lists (`/e2ee/nodes`, names and ids only) and asks for its list.

## Who can't hold a device cert

- **claude.ai** connects from Anthropic's servers with OAuth over HTTPS, so its TLS has to end
  at the node for the relay not to read it. A Worker can't pass TLS through, so a small TLS
  relay of our own does it (**Decide**).
- **The web page** (portal, machineless page) can pair as a device, with the keys in
  IndexedDB as non-extractable WebCrypto keys where the browser has X25519. e2ee.md's open
  question still stands: a page served from our domain can be changed to take the keys. The
  signed desktop app and Nix builds remain the clients you don't have to trust us for.
- **fleetd** holds a node owner token today, and would need a device of its own. See
  **Decide**.

## Build order

1. **The channel.** lib/e2ee/channel.ts (handshake, frames, streams), the relay's
   `/e2ee/channel` and its routing in Nodes, lib/e2ee/relay.ts's client. Tests: two devices
   over the test relay; a revoked or other-account cert is refused; a relay that swaps keys or
   replays a frame is caught; a stream larger than 17 MB and one longer than 60 s.
2. **The node over the channel.** serve.ts accepts channels and serves its HTTP on them. Android
   gets a channel client (Kotlin, lazysodium: X25519, XChaCha20, Ed25519 are all there), and
   its node calls move off `/n/<handle>`. The portal does the same once it can pair (step 6).
   fleetd uses it too once it has a device (**Decide**).

   As built (2026-11-06):
   - serve.ts serves the node's HTTP on channels at the tunnel's origin, so the phone's
     tokens work on either. A request on a channel with no Authorization header is the peer
     device's, as the owner. `/app` and `/app/events` stay loopback-only.
   - **The relay-only cert** is a DeviceCert with `role: "relay"`, signed only when present,
     so every other cert signs as before (Wire.kt has it too). `corkboard-bridge e2ee
     relay-device DEVICE BOX` makes one on a machine with the root. Its relay tokens get 403
     on everything but `/e2ee/channel`, GET `/e2ee/nodes` and GET `/e2ee/revoked`.
   - **fleetd**: `corkboard-fleet device` makes its keys and prints the relay-device line;
     `corkboard-fleet device cert < cert.json` keeps the cert. The manifest's `node.device`
     names the file. fleet/fleetd/node.ts opens a channel to the leader, or else the newest
     node, and reopens it after it ends. Without `device`, fleetd uses the tunnel url and the
     token file as before. A rotation (bridge rotateAccount) keeps only the rotating device,
     so fleetd's cert must be issued again after one.
   - **Android needs no move**: it never called `/n/<handle>`. It is a paired device with its
     own replicas, so a channel client is moot for node calls. Sessions (step 3) still need one.
   - **Spawned guests and Pepper's guest** (fleetd.ts start()'s `remote.mcp` and memory urls;
     fleet/pepper/guest.nix's `node`) are HTTPS clients like claude.ai. They move to step 5's
     `<label>.n.corkboard.fyi`, not to a fleetd proxy.
3. **Sessions over the channel.** sessions.ts's `serve()` answers on channels, and fleetd's
   sessions.ts likewise. cloud-session.ts's `fleet_*` (Neovim, the web page) open channels.
   Android's Sessions.kt and Avatar.kt's speech go over the channel. Once a machine serves
   channels, it stops sending its session list to the User DO, and the Worker's
   `/api/sessions*` answers 410 for the account. An unpaired phone then sees no sessions and
   gets the pairing row.

   As built (2026-11-06), with the Worker's path kept beside it:
   - **The node is the machine's hub** (bridge/hub.ts), the User DO's session role done
     locally. A device has one relay socket, so its bridges can't each answer channels. Every
     bridge on the machine joins the node's hub and speaks what it speaks to `/api/live?bridge=`.
     An in-process bridge joins directly. Another bridge's process joins on loopback: `GET
     /app/sessions/live` (SSE, hub to bridge) and `POST /app/sessions` (a list, bridge to hub).
     sessions.ts's `core()` gives each link its own streams, so the Worker's socket and the hub
     are both served at once.
   - **The routes are the Worker's own:** `/api/sessions[?follow]`, `/:b/:k`, `say`, `speech`
     and `attach[?terminal]`. Follow and attach are ndjson, and attach takes `in`/`size` in the
     request body. They're served on a channel only to a device without `role`, or on loopback.
     The plaintext tunnel answers them 404.
   - **fleetd** keeps an in-process hub and answers channels on a socket of its own with
     `tunnel: false` (`answerChannels`). The relay lists that socket in `/e2ee/nodes` but never
     sends the tunnel there, and the node pickers skip it.
   - **Watching** (bridge/peers.ts): the node reaches every hub of the account's. Its own is
     served in-process; each connected device's is on a channel the node opens and keeps
     (serve.ts's `reach`). A bridge reaches them through `/app/peers` and `/app/peer/:device/
     api/sessions...` on loopback. `Peers` follows each device's `?follow`, keeps its bridges
     while the channel is down, and drops them when the device goes. cloud-session.ts's
     `fleet_get` and `fleet_subscribe` list them first, then the Worker's other bridges, and drop
     the Worker's events for a bridge the hubs have. `fleet_follow`, `fleet_terminal` and
     `fleet_say` go over the channel when the hubs have that bridge. Away mode's peers merge the
     same way (remote.ts, sessions.ts's `sealed`). A page with no machine still uses the Worker.
   - **Still to do:** Android's channel client (a Kotlin port of channel.ts, with TS/Kotlin
     vectors), then Sessions.kt, Avatar.kt's speech and Cloud.kt. After those and the portal's
     replacement (its account and boards pages, and the Worker's workspace tickets read the
     bridge registry), the cutover: bridges stop telling the User DO, and `/api/sessions*`
     answers 410.
4. **The fleet sealed.** A spawn's task, result, shell and secrets are sealed to the fleet's
   device (or a fleet object's key). The Worker keeps ids, state, sizes and times for the queue.
   Environments' manifests move into an encrypted `fleet` object. Holds are sealed on the
   device that made them and opened by fleetd at the claim; `HOLDS_KEY` is gone for the account.
   fleetd stops sending `result` to the Worker.
5. **The TLS relay, and the plaintext tunnel gone.** relay-tls/ (SNI routing, the nodes'
   reverse connections, the node's ACME client and its TLS listener in serve.ts), deployed on
   the droplet in front of Caddy. claude.ai's connector moves to `<label>.n.corkboard.fyi`.
   Once 2-4 are done, `/n/<handle>` answers 410. Tests: a connection whose SNI no node holds is
   refused; the relay process never sees a byte of plaintext (a node with a self-signed test
   CA, and the relay's own buffers checked).
6. **Pages pair.** The portal and the machineless page pair as devices and use channels. The
   portal's localStorage OAuth tokens go.
7. **Leftovers.** Meeting transcripts go to the node over the channel. Brains' records go into
   the account's objects. The Worker's plaintext features stay only for accounts that haven't
   moved, until the migration (e2ee.md step 4) takes them off.

## Decide

- **claude.ai's connector** (decided 2026-11-05: no vendor dependency, so no Tailscale Funnel).
  We run our own TLS passthrough relay, e2ee.md step 5's "TLS-forwarding relay":
  - A small Bun server on a VPS (the droplet) listens on 443 and reads each connection's SNI.
    It pipes the raw TCP to that node, over a connection the node keeps open to it. It never
    holds a key.
  - Each node gets a hostname `<label>.n.corkboard.fyi` (a wildcard A record to the relay).
    The label is a lowercase base32 form of the handle, since the handle's `_` isn't allowed in
    a certificate name.
  - The node gets its own ACME cert (Let's Encrypt, or any ACME CA). It answers TLS-ALPN-01
    through the passthrough, so it needs no DNS access.
  - claude.ai's `/mcp` and OAuth go to that hostname. Once it works, `/n/<handle>` stops
    answering.
  - Caddy holds 443 on the droplet now. The relay goes in front and passes
    `workspace.corkboard.fyi` to Caddy on loopback.
  - The protocol is published, so a user can run the relay themselves, or point a hostname of
    their own at a node with a public port.
- **fleetd's identity** (decided 2026-11-05: (b), the user approved the plan as recommended).
  (a) Pair fleetd as a full device: it gets the root, so the droplet can
  read everything. (b) A new kind of cert, a *relay-only device*: signed by the account, with a
  box key and no root. It can open and answer channels and receive sealed spawns and holds, but
  can't read objects. It's still a node grant for what it does on the node. **Recommended:
  (b).** It replaces the owner token fleetd holds today.
- **The calendar's refresh token.** It conflicts with "ciphertext only": the Worker holding it
  could read the calendar, though it never sees a plan. (a) Keep it, as the one stated
  exception, with no new consent (what was decided earlier today). (b) Move it to the node with
  the user's own Google client (`serve calendar-login`), which means a new consent and a
  client of their own. **The user decides.**

## Open

- Session presence while no watcher is connected. Today the Worker's list is what the phone
  shows the moment it opens. Asking each device costs a round trip per machine; cache the last
  lists on the phone.
- Speech audio is large for a channel over a phone's link. Measure it before deciding to send
  text only and synthesise on the phone.
