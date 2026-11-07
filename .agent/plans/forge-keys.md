# Forge keys: the account root is Forgejo's credential

**Written:** 2026-11-06 · **Proposed, not decided.** The account key that roots e2ee (its
DeviceCerts, `lib/e2ee/wire.ts`) is also what signs into git.corkboard.fyi. A device with a cert
is the account in Forgejo; it can hand a VM a grant for named repos with per-permission levels,
like GitHub's fine-grained tokens, signed back to the root. Replaces the Worker's `/api/git` proxy
and its `FORGEJO_TOKEN` (e2ee.md, "What moves out of the Worker"). Out of scope for now: Forgejo
Actions, and SSH for agents (HTTPS through the gate only).

```
root ──cert──▶ device (laptop, phone, page) ──ForgeGrant──▶ VM's device (fleetd's relay device)
                    │                                             │
                    └──── signed request ──▶ forge gate ◀─────────┘
                                             (droplet, beside Forgejo)
                                                  │ verifies the chain, the grant's permissions,
                                                  │ revocations; then as the account's user
                                                  ▼
                                             Forgejo (reverse-proxy auth, 127.0.0.1 only)
```

## Why a gate, not Forgejo's own credentials

Forgejo's access tokens are a user's, scoped by kind (read:repository, write:issue...) but not by
repo, and they're bearer secrets Forgejo stores. A gate that checks signatures needs nothing
stored but the account's public key, scopes to a repo, expires and revokes with the e2ee
revocations, and works from a browser (no token in the page).

## Pieces

1. **Binding.** Automatic: nothing to run. The first full device of the account to start a
   bridge with an SSH key Forgejo has for its user signs `ForgeBind { v, origin, id, key, by,
   user, at }` (by: the device, its cert sent with it; or the account's key), sent with the
   account's view (its creation and rotations, so the gate can tell the key is the account's
   now) and that SSH key's signature over it (`ssh-keygen -Y sign`, namespace
   corkboard-forge-bind), which the gate checks against the user's keys in Forgejo
   (`/api/v1/user/keys`, asked as them). A Forgejo token of the user's also works, checked and
   never kept. The user is what Forgejo's ssh greets the key as. The gate keeps account →
   Forgejo user. A rotation is sent on as a newer view (`POST /gate/account`); an older one
   can't take the key back. Every full device is then the account, with nothing to set up;
   grants are only for agents.
2. **The gate.** A small Bun service on the droplet at git.corkboard.fyi (Caddy sends HTTPS to
   it; Forgejo listens on 127.0.0.1 only, with `ENABLE_REVERSE_PROXY_AUTHENTICATION` and `_API`
   trusting only the gate). A key opens a session: it shows its chain (the first issuer's cert,
   then each grant) and signs the gate's nonce, and gets a `cbg_` token for an hour or until
   its grant expires, used as a bearer or as Basic's password, so plain git and a page's
   isomorphic-git need nothing per request. The gate checks the chain against a bound account
   and the revocations it has been sent (`POST /gate/revoke`; the relay's list needs a signed-in
   device, so clients send revocations here too), then, per request, that it's within the
   grant, and sets the user header, which it strips from every other request. A full device is the account outright; the web
   UI is for full devices only. Human sign-in to the web UI keeps Forgejo's own login.
3. **Grants**, modelled on GitHub's fine-grained tokens:

   ```
   ForgeGrant {
     v, account, holder: device id, name, issued, expires,
     repos: ["owner/name", ...] | { owner: "matt" },   // listed repos, or all of an owner's
     permissions: { contents: "write", pull_requests: "write", issues: "read", ... },
     refs?: ["agent/*"],                                // push only to these (beyond GitHub's)
   }
   ```

   Signed by a full device, or by a grant's holder (below). Each permission is absent (none), `read` or
   `write`; `write` implies `read`. `metadata: read` is always given for the listed repos.

   | Permission | read | write |
   |---|---|---|
   | `metadata` | the repo, its branches, tags, commits, collaborators' names | (none) |
   | `contents` | clone and fetch (`git-upload-pack`), contents, archive, raw | push (`git-receive-pack`), contents edits, branches and tags made or deleted |
   | `pull_requests` | PRs, their reviews, comments, files | open, comment, review, close, merge (merge also needs `contents: write`) |
   | `issues` | issues, labels, milestones, comments | open, comment, label, close |
   | `releases` | releases and their assets | make, edit, delete, upload assets |
   | `statuses` | commit statuses | set them |
   | `wiki` | clone and read the wiki | push it |
   | `administration` | settings, branch protection, collaborators | change those, rename, archive; delete only with it and the grant's `delete: true` |
   | `webhooks` | hooks | make, edit, delete |

   The gate holds a table of Forgejo's `/api/v1` routes and git's smart-HTTP paths to (permission,
   level); a route not in it is refused to a grant. For pushes it reads the pkt-line ref
   updates and refuses refs outside `refs`, and deletions unless `contents: write` covers it.
   Account-wide permissions (making repos, keys, the user's settings) aren't grantable; a full
   device only.
   Revoking the VM's device kills every grant to it; a grant can also be revoked alone (its hash
   in the revocation list).
4. **Sub-grants.** A grant's holder can sign a narrower grant to another device (a sub-agent's),
   with `parent: hash of its own grant`. The request carries the whole chain, root cert first;
   the gate checks every link and the narrowest is what's allowed. A child must be within its
   parent on every axis, or the gate refuses the chain:
   - `repos` a subset (an owner's-all parent covers any of that owner's repos)
   - each permission at or below the parent's
   - `refs` within the parent's: refs are exact names or prefix globs (`agent/*`,
     `agent/card-12/*`), so "within" is a prefix check
   - `expires` no later than the parent's
   - `delete: true` only under a parent with it
   Revoking a link (its holder's device, or the grant itself) kills everything below it. Chains
   are at most 4 grants deep. fleetd makes each sub-agent its own key, so a sub-agent's revoke
   doesn't touch its parent's.
5. **Making grants.** From the palette ("Give git access") and from a fleet template: the
   template names repos and permissions; the node signs the grant at spawn (a spawn from inside
   a VM gets a sub-grant from that VM's, no wider than what the spawn's template asks) (the sealed fleet
   object already carries a spawn's secrets) with the spawn's lifetime as `expires`, and fleetd
   presents it: it opens a session and hands git the token (a credential helper, renewed before
   the hour is up).
6. **Clients.** The wasm page and the portal open sessions with their own device key straight to the gate
   (CORS for corkboard.fyi); bridge/server.ts's `gitProxy` and the Worker's git.ts go.

## Open

- The gate is trusted by Forgejo to say who's who, so it lives on the droplet with Forgejo; the
  droplet still sees the code in plaintext. This is about who can reach the code, not hiding it
  from the forge.

## Status

- 2026-11-06: the gate is written, not deployed. `lib/e2ee/forge.ts` (bindings, grants, chain
  checks, narrowing; tests in lib/e2ee/test/forge.test.ts), `forge/gate/` (gate.ts the handler,
  routes.ts the permission table, push.ts reads a push's ref updates, store.ts SQLite, main.ts
  the service; gate.test.ts against a fake Forgejo). `bun test forge lib/e2ee`; typecheck clean.
- Left: deploy on the droplet (Nix profile + service like Forgejo's; Caddy → gate; Forgejo on
  127.0.0.1 or a unix socket with reverse-proxy auth on, its header a name only the gate and
  app.ini know, since anything on the droplet can reach 127.0.0.1); check Forgejo 16 honours
  reverse-proxy auth on git's smart HTTP and the API; "Give git access" in
  the palette; fleetd's session and credential helper; the page and portal onto the gate; the
  Worker's git.ts and the bridge's gitProxy removed; revocations sent to the gate wherever the
  relay gets them. LFS isn't in the table (refused to grants).
- 2026-11-06: the gate is deployed on the droplet. Profile /nix/var/nix/profiles/forge-gate
  (flake's `forge-gate`), `forge-gate.service` as user forge-gate (group forgegate) on
  127.0.0.1:3001, state /var/lib/forge-gate, the header name in /etc/forge-gate/env. Caddy's
  git.corkboard.fyi goes to it. Forgejo listens on /run/forgejo/forgejo.sock (tmpfiles
  forgejo-sock.conf, 2770 git:forgegate; forgejo.service.d/gate.conf) with reverse-proxy auth on
  for web and API. Checked: the header signs in on /api/v1 and git's info/refs, a header from
  outside is refused, other droplet users can't reach the socket, SSH git still works.
  Backups: app.ini.bak-gate-2026-11-06, Caddyfile.bak-gate-2026-11-06.
- 2026-11-06: binding is automatic (bridge/e2ee.ts forgeBound, at the bridge's start and before
  a grant): a full device's binding, shown by its SSH key (forge/gate/ssh.ts checks it with
  ssh-keygen). No "Connect git". "Give git access" is in the palette (corkboard/forge.lua).
  fleetd: a template's `git` gets a grant from the node at a spawn's claim, a gate token in
  the slot's share renewed before it's out, and git's credential helper in the guest reads it
  (fleet/fleetd/forge.ts). Left: sub-grants from inside a VM, egress allowlists naming
  git.corkboard.fyi, re-grants for sessions past 24h.
- 2026-11-06: checked live end to end. This laptop's device opened a session (scope null, as
  mattjurenka) and fetched and read the API with the cbg_ token; a bogus token gets 401. A
  grant to a fresh key (contents:write, refs agent/*) reads the repo, gets 403 on another
  repo, and its push outside agent/* is refused (no ref made). Revocations: the bridge's
  `e2ee revoke` sends the device's to the gate too; "Take back git access" in the palette
  (forge_grants, forge_revoke) revokes a grant given from here; checked live (200, then 401,
  then a new session refused).
- 2026-11-06: fleet deployed on the droplet. corkboard-fleet profile → rq4cn3lf… (flake.nix's
  fleet fileset gained fleet/fleetd/forge.ts; the first try without it failed to start and was
  rolled back), slot profile corkboard-slot-cloud-coding → nma8z0d2… (the git credential
  helper), git.corkboard.fyi in cloud-0-allowed-domains.filter (backup .bak-forge-2026-11-06)
  and in fleet/lib.nix's coding egress. cloud-coding in fleet.json has no `git` yet, so its
  spawns get no grant until it does.
- 2026-11-06: cloud-coding has git in the droplet's fleet.json (repos mattjurenka/*, contents,
  pull_requests and issues write, refs agent/*; needsApproval true; backup
  fleet.json.bak-git-2026-11-06). Re-grants: fleetd asks the node for another grant to the same
  key 2h before a spawn's runs out (forge.ts's regrant, kept with the spawn), and goes on with
  the old one while the node can't; the node signs again and takes back the one before, and
  refuses once fleetd took the spawn's back at its end (gitOver). Deployed (fleet mzvsz9db…).
  The laptop's node (corkboard.service, the installed package) needs the system switched to
  sign any of it. Left: sub-grants for spawns asked from inside a VM.
- 2026-11-06: checked from a real spawn (cloud-coding, mw5s6fyw0l3q): its grant read the repo,
  pushed agent/fleet-e2e, and a push to another branch got 403 (no ref made; the test branch is
  deleted). Two things were in the way, both on the droplet: fleetd reached the node over the
  plaintext tunnel, where the node serves no sealed fleet routes (404), so it's a relay-only
  device now (fleet.json's node.device); and cloud-0's host rules were still proxy-only from
  before slots went open, so they're host.nix's open rules now, plus 443 on the droplet's own
  public address, since git.corkboard.fyi is Caddy there. Left: sub-grants for spawns asked
  from inside a VM; the page and portal onto the gate (pages aren't paired devices yet).
