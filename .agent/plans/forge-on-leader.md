# Forgejo on the leader: the user's forge runs on a node they trust

**Written:** 2026-11-06 · **Decided:** the only backend run for users is Cloudflare, and nobody
has to trust us with their code. Forgejo and the gate run on the account's leader node, a machine
the user trusts (for Matt, the droplet). The web service is a convenience: using it means trusting
us, so a plain browser may go through the Worker in plaintext, as an opt-in. **Proposed:** the rest.

Supersedes forge-keys.md's hosted gate (pieces 2 and 6), self-hosted-git.md's droplet steps 1, 2
and 4, and ciphertext-relay.md's step 5 (the TLS passthrough relay).

```
bridge (laptop) ─┐                                 leader node (droplet, or any full device)
phone app ───────┼── sealed channel ──▶ relay ──▶   serve.ts ── forge handler (the gate's logic)
fleetd ──────────┘    (ciphertext)    (Worker)                        │ user header
  └ runner VM, spawn VMs: loopback proxy in fleetd                    ▼
                                                                 Forgejo (unix socket)
browser ── HTTPS ──▶ Worker ── /n/<handle> tunnel ──▶ node     (opt-in, trusts us)
browser ── HTTPS ──▶ own domain ──▶ node's public port          (Matt: git.corkboard.fyi)
```

## Pieces

1. **Forgejo under the node.** The node runs Forgejo as a child (its own Nix package, a unix
   socket, state under the node's directory, SQLite), started when the node leads and stopped
   when it hands off. Reverse-proxy auth trusts only the node, as the gate does now
   (forge/gate's header name, kept in the node's env).
2. **The gate goes into the node.** forge/gate/gate.ts's handler is served by serve.ts on
   channels under `/forge/`. The channel already proves the peer's device, so a full device is
   the account with no `cbg_` session. A relay-only device (fleetd) shows the grant chain once per
   channel, and every request is checked against it as now (routes.ts, push.ts). Bindings and
   revocations are the node's own: it reads the account's view and revocation list directly, so
   `POST /gate/account` and `/gate/revoke` go.
3. **Clients over channels.**
   - The bridge serves a loopback proxy (`http://127.0.0.1:<port>/forge/<owner>/<repo>.git`) that
     carries each request over its channel to the leader, so plain git and isomorphic-git work
     unchanged. It replaces server.ts's `gitProxy`. A `corkboard::` remote helper can come later
     if a stable URL across machines matters.
   - fleetd serves the same proxy to its slots and VMs on their host address, carrying the
     spawn's grant. The guest's credential helper goes (the proxy adds the grant), and egress
     lists name the proxy, not git.corkboard.fyi.
   - The phone app reads repos over its channel (Relay.kt's `channel(to)`).
4. **The browser, on trust.** `corkboard.fyi/forge/` goes to the leader's `/n/<handle>` tunnel,
   in plaintext through the Worker. It's off until the account turns it on, with the setting's
   label saying the Worker sees the traffic. Signing in to the web UI keeps Forgejo's own login.
   A user with a domain points it at their leader's public port instead (Matt keeps
   git.corkboard.fyi through Caddy on the droplet).
5. **State follows the leader.** The leader writes encrypted snapshots to the relay: a
   `git bundle` per repo for each push and a Forgejo DB dump on a timer, sealed to the account. A
   new leader restores the latest before it starts Forgejo. These snapshots are also the backup,
   so Walrus isn't needed (self-hosted-git.md step 2 is dropped).
6. **Actions, a VM per job and none when idle.** fleetd asks Forgejo for waiting jobs
   (`GET /user/actions/runners/jobs?labels=…`, in 16.0.6) and boots a `ci` template VM in a slot
   for each, queued with agent spawns under the same memory budget. The guest runs
   `forgejo-runner one-job --handle <job>` (runner 13.2) in host mode, and the VM is gone when
   the job ends, so nothing carries over to the next job. The runner reaches Forgejo through
   fleetd's proxy (piece 3), its token handed in by fleetd like a spawn's grant. Labels say where
   a job runs: `droplet` (up to ~2 GB), and `big`, served only by the laptop's fleetd. Forgejo's
   OIDC issuer (`id-token: write`, for AWS) has to be reachable publicly, since AWS fetches its
   `/.well-known/openid-configuration` and keys. On an own domain that's free. Otherwise the
   tunnel serves just those two public paths, even when the browser opt-in is off.
7. **What goes.** The hosted forge-gate service and its Caddy site (once Matt's own domain
   points at the node's handler), the Worker's `/api/git` and `FORGEJO_TOKEN`, the bridge's
   `gitProxy`, and relay-tls/: claude.ai web keeps `/n/<handle>` as a trust-us option, and
   Claude Desktop and Claude Code use a local MCP.

## Decide

- **State handoff:** (a) snapshots, as in piece 5, where a failover loses what came after the
  last DB dump (pushes aren't lost; they're bundled as they come); (b) continuous replication
  of the DB and repos to followers. **Recommended: (a).**
- **Runner capacity (2026-11-07, measured): no resize.** The "full" 4 GB was reservations.
  Real use is ~2.0 GB, with ~1.9 GB available and 1.5 GB of swap free (pepper-vm 785 MB + 300
  swapped, node 670, Forgejo 260, the rest small), so one job VM of up to ~2 GB fits at a time.
  baum's 3–4 GB builds take `big` (the laptop). Headroom if needed: the node's 670 MB is worth a
  look; fwupd, multipathd, ModemManager and udisks2 (~80 MB) can go; virtio-balloon free-page
  reporting would hand back Pepper's idle guest memory.
- **Stable and Baum:** whether GitHub stays as a mirror, a pull-mirror source, or goes away, and
  what Winston pushes to.

## Order

1. Actions first, on today's droplet Forgejo, since it doesn't depend on the move: the `ci`
   template, fleetd's job poller, a runner token (Matt makes it in the web UI), a throwaway workflow that
   checks `concurrency` and `id-token`. Then port baum's and stable's workflows.
2. The forge handler in serve.ts, beside the hosted gate; the bridge's loopback proxy.
3. Forgejo under the droplet's node; move `/var/lib/forgejo` into it; Caddy's git.corkboard.fyi
   to the node; the hosted gate stopped.
4. fleetd's proxy; the guest credential helper gone.
5. Snapshots to the relay, and a restore checked on the laptop as leader.
6. The browser opt-in; the Worker's git routes removed.

## Status

- 2026-11-06: written. Forgejo 16.0.6 still runs as `forgejo.service` on the droplet behind
  forge-gate. Actions are enabled with no runner installed, and there are no backups.
- 2026-11-07: step 1's runner is live. fleetd polls `/user/actions/runners/jobs?labels=droplet`
  every 10s (fleet/fleetd/actions.ts), registers an ephemeral runner per waiting job, and queues
  a `ci` spawn (fleet/caps/actions.nix, 1536 MiB, 2 cores) that runs `forgejo-runner one-job`
  and powers off; the runner is deleted once the spawn is over. Token: mattjurenka's
  `fleet-actions` (write:user, write:repository; made with the admin CLI straight into
  /var/lib/corkboard/forgejo-actions-token). `mattjurenka/actions-test` run 1 (`runs-on:
  droplet`, `concurrency`, `id-token: write`, actions/checkout from code.forgejo.org) passed in
  11s of job time. Not yet checked: what the job sees of `id-token` (its step logs), and two jobs
  queued at once. Left: port baum's and stable's workflows.
