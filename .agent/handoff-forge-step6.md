# Forge step 6 map (2026-11-11): browser opt-in, Worker git routes removed

**The hosted Worker isn't in this repo.** It's in /home/matthew/corkboard-cloud (cloud/, portal/, site/, android/; corkboard is a submodule there, older than this HEAD). This repo's Worker is relay/, which has no git routes.

## Worker git surface (corkboard-cloud)
- `cloud/src/git.ts` is all of `/api/git`: repos, branches, contents, info/refs, git-upload-pack. It uses `FORGEJO_TOKEN` against `FORGEJO_ORIGIN`/api/v1.
- `cloud/src/api.ts`: route comment :94-95; `git:` capability flag :420; dispatch :1079-1081.
- `cloud/src/index.ts:69-72` env types; `cloud/wrangler.jsonc:68-71` (the var and the secret); `cloud/vitest.config.ts:23-24`; `cloud/DEPLOY-NOTES.md`; tests `cloud/test/git.test.ts`, `tenants.test.ts:107-110`.
- Callers:
  - portal: `components/boards.tsx:37,155`, `components/files.tsx:51,85,447`, `lib/remotes.ts:15`
  - web wasm: `web/src/nvim/wasm/rpc.ts:292` (repoOf) and :316-325 (isomorphic-git clone of api/git/repos/... with Bearer); the clone itself runs in `machine/machine.ts`, `git.ts`
  - bridge: `bridge/server.ts:821` gitProxy
- Gate endpoints called from the bridge:
  - `lib/e2ee/forge-client.ts` sendViewToGate (/gate/account, no callers); sendRevocationToGate (/gate/revoke), called from `bridge/e2ee.ts:412,648` and `bridge/node/fleet.ts:215`
  - `bridge/e2ee.ts:293` FORGE_GATE; forgeBound (/gate/bind) :342-361, called at `bridge/server.ts:954-958`
  - `bridge/node/fleet.ts:46` FORGE_GATE; `bridge/node/serve.ts:209` `gate: FORGE_GATE` in grants
  - `nvim/lua/corkboard/forge.lua` uses forge_status (`bridge/boards.ts:102`)

## Bridge proxies
- `bridge/server.ts:618-632` gitProxy forwards /api/git/* to the Worker. Its only user is wasm `rpc.ts:325`.
- Loopback /forge/ already exists: `bridge/server.ts:634-654` forgeProxy. It refuses requests with an Origin, so a page can't use it. Path: `bridge/node/app.ts:87-89,317-321` → `bridge/node/server.ts:625-635` → `serve.ts:249-256` toForge (local if leading, else over the channel to the leader).
- Commit 5073722 says "gitProxy stays until the droplet's Forgejo is the node's". That has happened, so gitProxy can go once wasm has another source.
- `bridge/node/server.ts:571-574` serves channel /forge/ only with a `from` peer cert, so through the /n/ tunnel it's 404 today.

## Tunnel and opt-in
- `relay/src/routes.ts:179-210` tunnel(): `/n/<handle>/...`. It strips cookies (HOP, :187), so Forgejo's web login won't survive it as is. It also rejects Upgrade, caps size, and calls `Nodes.forward` (`relay/src/nodes.ts:105-135`).
- The only account-level relay toggle is the leader, in the Nodes DO `meta` table (`nodes.ts:43-55`). Put an opt-in flag next to it as a meta key and check it in tunnel(). Endpoints: `/e2ee/nodes` (routes.ts:326-354); client `lib/e2ee/relay.ts:24,298`; bridge ops nodes_list/nodes_leader (`bridge/node/app.ts:327-330`).
- UI: `web/src/views/Settings.tsx:123-145` Devices section (leader Check :141); nvim `settings.lua:324-331,369-390`.
- Hosted: `corkboard-cloud/cloud/src/index.ts:149-152` puts tunnel() before OAuth, at portal.corkboard.fyi. corkboard.fyi is a separate static Worker (`site/wrangler.jsonc`, run_worker_first only for /d/*, /apt/*, /rpm/*, no NODES binding). corkboard.fyi/forge/ needs a route or service binding to the cloud Worker, plus a way to name the account (e.g. /forge/<handle>/).
- On the node: a no-`from` tunnel path for /forge/ at `bridge/node/server.ts:571`. It sends no user header, so Forgejo's own login applies.

## Hosted gate
- `forge/gate/` (gate.ts, main.ts, proxy.ts, push.ts, routes.ts, ssh.ts, store.ts) is deployed by `flake.nix:274-298` as forge-gate.service on the droplet, behind Caddy at git.corkboard.fyi.
- It can't be deleted wholesale: `bridge/node/forge.ts:21` imports forgeProxy from `forge/gate/proxy.ts`, and `fleet/fleetd/forge.test.ts:13-14` imports gate.ts and store.ts.
- relay-tls/ is already gone.
- Turning off the droplet's hosted gate or Caddy is a deploy change: ask Matt first.
