# corkboard in a Cloudflare Container: the laptop UI, hosted

**Written:** 2026-10-29 · **Decided:** the page is served by the Worker and drives a bridge and
Neovim running in a Cloudflare Container, one per user (the "workspace"); projects get there by
cloning from one of their remotes; the workspace's disk is snapshotted when it goes idle and
restored when it wakes.

Today the page (web/) is served by the bridge on the laptop, and everything it does rides one
WebSocket, `/nvim`: msgpack-RPC as JSON frames to `nvim --embed` (bridge/server.ts). Nothing of it
goes through the Worker. This plan runs the same bridge in a container and puts the Worker in front.

```
browser ──https──▶ Worker ── static web/dist
   │                  │
   └──wss /nvim──────▶ Workspace DO ──getTcpPort(8080).fetch──▶ container: bridge ─▶ nvim --embed
                         │                                          │
                         └─ alarm: idle → snapshot → destroy        └─ ~/src/<project> (cloned)
```

---

## What Cloudflare gives (docs as of 2026-10-29)

- **Durable Object Container API** (`this.ctx.container`): `start({ image | containerSnapshot,
  instance, enableInternet, env, entrypoint })`, `getTcpPort(p).fetch()` (forwards WebSocket
  upgrades), `setInactivityTimeout(ms ≤ 6h)`, `snapshotContainer()`, `destroy()`, `monitor()`.
- **Snapshots** need `scheduling_policy: "durable_object"`, which is **public beta**. Manual only;
  capture the writable root filesystem (not processes); ≤ 20 GB; kept 30 days from creation or last
  restore; **tied to the image they were taken on**.
- **Disk is otherwise wiped** whenever a container stops. Cold start ~1–3 s, plus a snapshot restore.
- **Sizes:** `standard-2` (1 vCPU, 6 GiB, 12 GB) to `standard-4` (4 vCPU, 12 GiB, 20 GB), or custom.
- **Pricing (Workers Paid):** memory $0.0000025/GiB-s and disk $0.00000007/GB-s on the provisioned
  size while running, CPU $0.000020/vCPU-s when used. standard-2 running ≈ $0.06/hour before CPU;
  nothing while asleep. Snapshot storage isn't priced on the docs page.
- **Images:** linux/amd64, built from a Dockerfile by `wrangler deploy` (needs a local Docker), or a
  digest-pinned `registry.cloudflare.com/<account>/<repo>@sha256:…`.

## Steps

### 1. The image
Built by Nix (`dockerTools.buildLayeredImage`, in flake.nix beside `default` and `fleet`): bun, the
bridge, corkboard-nvim, git, gh, Claude Code, ripgrep, fd, a shell. The user's home is
`/home/corkboard`, which is everything a snapshot needs to keep. Entrypoint: the bridge on
`0.0.0.0:8080`, in proxied mode (step 4). Pushed to Cloudflare's registry and pinned by digest in
wrangler.jsonc, so the build doesn't need Docker inside `wrangler deploy`. Pushing still needs a
Docker-compatible CLI on the laptop (podman with docker compatibility, in nixosconfig), or CI.

### 2. The Workspace Durable Object (cloud/src/workspace.ts)
One per user, `idFromName(user)`. On a page's `/nvim`:
- not running: `start()` from its stored snapshot if it has one for the current image, else the
  image; `setInactivityTimeout`; wait for the bridge's health check.
- forward the upgrade with `getTcpPort(8080).fetch()`, with the workspace's secret (step 4) added.
- count open pages. When the last one closes, set an alarm (10 min). The alarm, if still no
  pages: `snapshotContainer()`, store the handle, `destroy()`. The inactivity timeout (longer)
  is the backstop when the DO itself was evicted.

**An image update orphans the snapshot.** The image map keeps the previous image by name; a
workspace whose snapshot is on an older image starts on it, tars `/home/corkboard` to R2, stops,
starts on the new image, untars, snapshots. Done once per workspace per image, on wake.

### 3. The page on the Worker
- `web/dist` as Worker static assets; the Worker's own routes (`/api`, `/mcp`, `/authorize`,
  `/token`, `/register`, `/callback`, `/.well-known`) run first.
- Sign-in: the page is a public OAuth client (PKCE, redirect back to the Worker's origin), keeps
  its token, and sends it on `/nvim` as the WebSocket subprotocol, as the bridge's token is today.
- Reconnecting waits for `/api/workspace` (is it up?) instead of `manifest.webmanifest`, which the
  Worker always answers.

### 4. The bridge in the container
- **Proxied mode** (`CORKBOARD_PROXIED=1`): the Worker has checked the user; the bridge checks
  only the workspace secret the DO passes at start (`env`), and skips the same-origin check, since
  the Origin is the Worker's and the Host the container's.
- **Its cloud token:** a `workspace` grant the Worker mints at each start (like card tokens), with
  the owner's scope, passed in `env`, instead of `corkboard login`.
- `CORKBOARD_FLEET_ENVIRONMENT=workspace`, so its boards record their clones there (`board_roots`).
- Claude Code and gh sign in once from a terminal in the workspace; the snapshot keeps them.

### 5. Projects from remotes
- Boards learn their project's remotes: Neovim sends `git remote -v`'s fetch URLs with
  `subscribe`, the Worker keeps them (`board_remotes`). Zero is fine: that board can't open in the
  workspace.
- Open project in the workspace lists the boards with remotes; picking one clones it to
  `~/src/<name>` from the first remote that answers (unless a clone with its first commit is
  already there), then opens it. The board resolves by first commit, as everywhere else.

### 6. The Electron app
Takes the Worker's URL like any other; it needs `accounts.google.com` allowed to navigate in the
window for sign-in (app/main.js `will-navigate`).

## Open
- Whether an open WebSocket alone keeps the container up (docs imply it, through the DO staying
  active). Checked on the first deploy.
- `durable_object` scheduling is beta; the policy can't be changed without recreating the app.
