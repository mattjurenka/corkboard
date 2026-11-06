# Step 3: who speaks the session protocol (2026-11-06, an Explore pass)

Paths are ~/corkboard unless they say corkboard-cloud.

## Android (corkboard-cloud/android/app/src/main/java/app/corkboard/)

All calls use the Worker OAuth bearer.

**Calls:**
- `Cloud.kt:335` `bridges()`: GET /api/sessions (Models.kt:184-208).
  - Bridge: `id, machine, environment, sessions, gone`.
  - BridgeSession: `key, spawn, project, name, state, since, detail, typed, host, vm, role, card, context, attach, persona, skin`.
  - Called from App.kt:142.
- `Cloud.kt:337` `terminal()`: GET /api/sessions/:b/:k returns `{lines, width, colors, palette}`. Called from Sessions.kt:207.
- `Cloud.kt:341` `type()`: POST .../say `{text, keys}`. Called from Sessions.kt:220 and :408, and Away.kt:95.
- `Cloud.kt:358` `speech()`: POST .../speech.
  - Body: the page's JSON `{text, voice, speed?, mood?}`.
  - Answer: s16 bytes, with headers `x-sample-rate, x-format, x-phonemes, x-frames`; 100 s timeout.
  - Called from Avatar.kt:78, which intercepts https://corkboard.fyi/meet/speech?q=.
- `Cloud.kt:375` `attach()`: WS .../attach, receive only.
  - `{type:"out", data: JSON {items, reset}}`, where each item is `id, at, kind, text, tool, call, detail, options, error, said{text, mood, emote}`.
  - `{type:"end", why}`.
  - No ?terminal. Called from Sessions.kt:361.
- `Cloud.kt:382` `live()`: /api/live. App.kt:217-223 handles `{type:"bridge"}` (merge, or drop when `gone`).

**Identity:** a paired phone has one: Encrypted.kt:123-217 `Me{device, cert, root}`.
- `relay(m)` (Encrypted.kt:199) builds an e2ee/Relay. Relay.kt:103-127 gets tokens.
- Relay.kt:216 opens WS with Authorization plus the `corkboard` subprotocol.
- Keys.kt:93 `checkCert` plus `Relay.revoked()` together give trust.
- An OAuth-only phone has no device.

**Crypto:** lazysodium 5.2.0. e2ee/Crypto.kt has X25519 `publicKey/shared` (rejects low-order points), `XChaCha.encrypt/decrypt` with an explicit nonce, `Ed25519`, `hkdf` and `sha256`. Wire.kt:103 has `signed(kind, map)`.

**Missing in Kotlin:** a port of channel.ts.
- The handshake (m1 `ie`; m2 `re || seal(kr, hello)`; m3 `seal(ki, hello)`).
  - h1/h2/h3 hashes and the "channel <label>" HKDF infos.
  - The hello is `{cert, sig}` over `signed("channel", {role, ie, re, h})`.
  - Check that R's cert is the device asked for; wait for READY; 30 s timeout.
- Frames: per-direction keys, nonce = 16 zero bytes + u64 BE counter, frame = type(1) || stream(u32 BE) || payload.
  - Types: READY, OPEN (JSON `{method, path, headers}`, odd ids for I), HEAD, DATA (≤64 KiB), END, RESET, WINDOW (256 KiB).
  - At most 256 streams.
- A fetch-style client over those streams.
- The /e2ee/channel WS link.
- The phone knows Worker bridge ids, not device ids, so it needs GET /e2ee/nodes to map them.

## bridge/cloud-session.ts `Session.fleet()` (:311-438)

- **`fleet_get` (:330):** GET /api/sessions alongside /api/fleet/environments and /api/spawns.
  - Drops its own bridge (`b.id !== link.self()`).
  - Callers: fleet.lua:667; claude.lua:235 and :270, which poll until a spawn's session appears.
- **`fleet_subscribe` (:325):** follows /api/live. fleet.lua:712 handles the `bridge` events.
- **`fleet_follow` (:340):** WS .../attach.
  - `out` becomes `conversation{bridge, key, items, reset}`; `end` becomes `conversation_end`.
  - Callers: conversation.lua:86; `fleet_unfollow` at :129.
- **`fleet_terminal` (:370):** WS .../attach?terminal.
  - `out` (b64) becomes `terminal{data}`; `end` becomes `terminal_end`.
  - Callers: mirror.lua:170; `fleet_unterminal` at :219.
  - `fleet_terminal_send` (:394) sends `{type:"size", rows, cols, focus}` (mirror.lua:158) and `{type:"in", data}` (mirror.lua:186).
- **`fleet_say` (:418):** POST .../say. Caller: conversation.lua:74.
- **Peers:** bridge/sessions.ts:171 `lookUp`, plus the `bridge` events on its socket, feed away mode (remote.ts peers). Away mode proxies screen and say to peers through away.ask (remote.ts:69-70).

## Web, the phone page, the portal

- **web/src:** no direct use. Away.tsx:64 gets its sessions through `nvim.notify("corkboard.away")`.
- **Phone page** (web/src/phone/main.tsx:49): fetches a relative `speech?q=` that Android intercepts. Nothing to change in the page.
- **Portal (corkboard-cloud):**
  - account.tsx:29 GET /api/sessions (`id, machine`); DELETE /api/bridges/:id (:101).
  - boards.tsx:36 GET /api/sessions, uses `b.url` (pages, workspace tickets).
- **Worker:** api.ts:713 (workspace tickets) uses `users.bridges()` for `environment` and `url`. The bridge registry is used outside the session traffic too.
- **Worker tests to update:** cloud/test/sessions.test.ts, tenants.test.ts:42-82, machine.test.ts:47-102.

## The Worker's DO (corkboard-cloud cloud/src/user.ts:615-802, routes api.ts:459-493)

**Routes:**
- GET /api/sessions: `{id, machine, url, environment, sessions[]}` (bridgeSession).
- GET /:b/:k: screen `{lines ≤300, width, colors?, palette?}`.
- POST say: `{text ≤20000, keys ≤16 from KEYS}`, returns `{ok}`.
- POST speech: `{type:"speech", sentence: body}`, 90 s (others 10 s). Returns octet-stream with x-sample-rate, x-format s16, x-phonemes, x-frames.
- GET attach[?terminal]: WS.
- DELETE /api/bridges/:id: close code 4001.
- `/api/live?bridge=`: a new socket replaces the old one (4000).
- Machine tokens are kept to their own environment.

**Asking the bridge:** `ask()` sends `{type, key, ..., ask:n}`. The answer is `{type:"answer", ask, error?, missing?}`; `missing` maps to 404, any other error to 502.

**What the bridge sends:**
- `sessions`: upserted into SQL and broadcast as `{type:"bridge", bridge}` to every non-stream socket.
- `out{stream, data}`: forwarded as `{type:"out", data}`.
- `end{stream, why}`: forwarded as `{type:"end", why}`, then the stream closes.

**Streams:**
- An attach sends `{type:"attach", stream, key, terminal?}` to the bridge.
- From the stream to the bridge, only `in{data ≤64K}` and `size{rows, cols, focus}` are forwarded.
- A stream closing sends `detach`.
- The bridge closing broadcasts `{bridge:{id, gone:true}}` and closes its streams with 1011.
