# corkboard fleet: brains, capabilities and where agents run

**Written:** 2026-10-27 · **Decided:** the VM machinery moves from `~/nixosconfig` into corkboard,
and nixosconfig keeps only its installation of it; a spawned agent always belongs to the brain that
asked for it; a template with no credentials spawns without approval; Pepper moves to the
DigitalOcean droplet, on Agent Sandbox; guest images are built by Nix, not Nix installed in Alpine.

Today the agent VMs are fixed, hand-named guests on omni-laptop (`claude-vm`, `brain-vm`,
`pepper-vm`), each with its own entry in `~/nixosconfig/modules/features/agent-vm/plan.nix`.
`brain-vm` is three things at once: the work brain, a coding environment, and a GPU Valheim client
(10 GiB, 6 cores, `gpu.nix`, `valheim-client.nix`). This plan splits those apart, so one capability
can run on the laptop or in the cloud, and either the user or a brain can spawn an agent.

---

## Concepts

```
brain ──owns──▶ agent ◀──instance of── template = brain + capabilities + allowed environments
                  │
                  └──runs in──▶ environment (local: omni-laptop microVM · cloud: droplet Sandbox)
```

- **Brain**: who an agent works for. Memory store, credentials, egress policy, and the corkboard
  token grant it acts under. Not a VM. Two to start:
  - `pepper`: personal. Corkboard notes as memory, personal Google (read-only calendar, mail),
    egress allowlist.
  - `work`: Stable. The vault in `~/second-brain`, Graph + GitHub tokens, open egress (as decided
    2026-10-11, see omni-laptop's configuration.nix).
- **Capability**: a NixOS module plus what it needs.
  ```nix
  coding     = { module = ./caps/coding.nix;  memory = 4096;  cores = 2;
                 egress = [ "cache.nixos.org" "github.com" "codeload.github.com" "registry.npmjs.org" ];
                 targets = [ "vm" "oci" ]; };
  display    = { module = ./caps/display.nix; needs = [ "display" ];  targets = [ "vm" ]; };
  screenshot = { module = ./caps/screenshot.nix; requires = [ "display" ]; targets = [ "vm" ]; };
  valheim    = { module = ./caps/valheim.nix; memory = 16384; cores = 6;
                 needs = [ "gpu" "display" ]; requires = [ "screenshot" ]; targets = [ "vm" ]; };
  ```
  `needs` is what the environment must provide; `requires` pulls in other capabilities;
  `targets` says whether the module also builds as an OCI image (gVisor containers have no
  systemd, so anything that needs a running NixOS is `vm` only).
- **Environment**: where agents run and what it provides.
  - `local`: omni-laptop. KVM microVMs, `provides = [ "gpu" "display" "kvm" ]`, a memory budget
    shared with the desktop (22.5 GiB total, no disk swap, zram), up only while the laptop is.
  - `cloud`: the DigitalOcean droplet. Agent Sandbox on k3s with gVisor, `provides = [ ]`,
    always on.
- **Template**: one brain + a set of capabilities + the environments allowed to run it. Its
  requirements are combined at evaluation: memory and cores take the largest value, egress
  lists are merged with the brain's, and every `needs` must be in the environment's `provides`.
  A template that can't be placed is an **evaluation error** (`valheim on cloud: needs gpu,
  display; cloud provides none`), never a runtime one.
- **Agent**: a running instance of a template. *Resident* agents are long-lived (Pepper's own
  session, the work brain's heartbeat); *spawned* agents are created for one task and torn down
  when it ends.

### Ownership

A spawned agent belongs to the brain that requested it. That brain is stamped by the Worker from
the requesting **token's grant**, never from an argument, so Pepper's token can only produce
`pepper` agents, and a `pepper` agent can never hold `work` credentials. A template's brain must
match the requester's, or the Worker refuses the spawn.

Every spawned agent gets a **spawn token**: a corkboard grant scoped to its own card (read the
task, write progress and the result). It is how the agent reports back. It does not count as a
credential for the approval rule below.

### Approval

| Template | Spawned by the user | Spawned by a brain |
|---|---|---|
| No credentials (e.g. `coding`) | runs | runs |
| Holds any brain credential | runs | a card with `attention`; boots only when the user accepts it |

"Credentials" is a property of the template, computed at evaluation: any secret the brain
mounts, any token other than the spawn token. The same rule keeps Pepper unable to accept its own
day plan.

---

## Repos

**corkboard owns the mechanism** (`fleet/` in this repo):

- `fleet/lib.nix`: the types (brain, capability, environment, template) and `mkFleet`, which
  checks placement and returns the guests and images.
- `fleet/host/`: today's `agent-vm/` (options, plan, host, all 1,939 lines), moved, then
  generalised from fixed instances to a slot pool.
- `fleet/caps/`: capabilities that aren't personal: `coding`, `display`, `screenshot`, `gpu`.
- `fleet/cloud/`: the droplet's NixOS module (k3s, gVisor, agent-sandbox controller, egress
  proxy) and the image builder (`dockerTools.buildLayeredImage`).
- `fleet/fleetd/`: the launcher daemon, TypeScript on bun like the bridge.
- Flake outputs: `nixosModules.fleetHost`, `nixosModules.fleetCloud`, `lib.mkFleet`.

**nixosconfig holds the installation**: which brains exist and what they hold, personal
capabilities (`valheim` for `verse`, the work brain's 1,944-line guest config), the templates,
and the two hosts (`omni-laptop` imports `fleetHost`, a new `pepper-droplet` imports
`fleetCloud`). It calls `inputs.corkboard.lib.mkFleet { ... }` and exposes the result as
`flake.nixosConfigurations` and image packages, the way `corkboard.nix` installs the bridge now.

---

## Spawning

```
 user: `corkboard fleet spawn work-coding "…"`  ─┐
 Pepper: MCP spawn_agent(template, task)        ─┼─▶ Worker UserDO `spawns` ──▶ fleetd (local) ─▶ slot microVM
 corkboard UI: card → "Run in…"                 ─┘    (brain from token,        fleetd (cloud) ─▶ SandboxClaim
                                                       approval rule applied)
```

- **One queue.** Every spawn, whoever asked, is a row in the Worker (`UserDO`, beside notes and
  plans) tied to a card: template, environment, task, state (`pending-approval` → `queued` →
  `running` → `done`/`failed`). Pepper has no channel back to the laptop, and needs none. It
  writes the request where it can already write.
- **fleetd** runs on each environment and holds one WebSocket to the Worker (as the bridge does
  per board). It claims queued spawns for its environment, boots them, mints the spawn token, and
  writes state back. If the laptop is off, local spawns wait in `queued`; nothing reroutes them,
  because a template's allowed environments are part of what was approved.
- **Local**: generic slots `agent-0..3` (own tap, /24, MAC, nftables table, as `plan.nix` gives
  each VM now) replace per-VM entries for spawned agents. A slot boots whichever template's guest
  it is handed. fleetd refuses to boot, and leaves the spawn `queued`, when the sum of running
  `memoryMax` would exceed the environment's budget. Valheim's 16 GiB plus the work brain's
  10 GiB does not fit, and starting it anyway is the Oct 10 freeze.
- **Cloud**: each template with `oci` in all its capabilities' targets becomes a
  `SandboxTemplate` pointing at its Nix-built image; a spawn is a `SandboxClaim`; a
  `SandboxWarmPool` of one keeps a `coding` sandbox ready. Pepper's resident agent is a plain
  `Sandbox` with a persistent volume for `~/.claude`.
- **Egress, both places**: no route off the machine but a filtering proxy that knows the
  template's merged allowlist. Local is today's design. Cloud is a default-deny NetworkPolicy
  (k3s's built-in controller enforces it) with one exception, the proxy pod, so no Cilium or
  FQDN policy is needed.
- **Getting in**: `corkboard fleet attach <agent>` opens a shell in the agent. That's ssh into a
  slot locally, and `kubectl exec -it` over ssh to the droplet for cloud. `plan.lua`'s
  `pepper-vm-ssh claude` becomes `corkboard fleet attach pepper`.

---

## Build order

1. **Move, don't change.** `agent-vm/` → `corkboard/fleet/host/`, exported as
   `nixosModules.fleetHost`; omni-laptop imports it from the `corkboard` input. Done when
   omni-laptop's generated nftables files, systemd units and launcher scripts are byte-identical
   before and after (diff the `etc` trees of the two toplevels).

   **Done 2026-10-27.** `fleet/host/{host,options}.nix` and `fleet/plan.nix` (`mkPlan`);
   flake outputs `nixosModules.fleetHost`, `lib.fleet.mkPlan`. nixosconfig keeps the instance
   list in `agent-vm/plan.nix` and installs the module from `agent-vm/host.nix`, which also sets
   the new `my.agentVms.plans` (it was `self.lib.agentVm.instances`). Checked against one frozen
   corkboard snapshot: the brain-vm, pepper-vm and claude-vm toplevels are the same derivations;
   omni-laptop's differs only in `system-path`, and only in the *order* of its 188 packages
   (the VM wrappers come earlier, being from an import). Same set, same store paths, every
   other attribute identical.
2. **Types and `mkFleet`.** Brains, capabilities, environments, templates, with the placement
   check. Re-express today's three guests as templates that build the *same* guests:
   `work` = work brain + `coding` + `valheim`, `pepper`, `browser` (claude-vm). Split
   `gpu.nix` / `valheim-client.nix` out of brain-vm into capabilities on the way.

   **Done 2026-10-27.** `fleet/lib.nix` (`lib.fleet.mkFleet`), tested by `fleet/tests.nix`
   (`nix flake check`, 12 cases). nixosconfig's `modules/features/fleet.nix` declares brains
   `work` and `pepper`, capabilities `gpu`, `valheim`, `wallet-browser`, `desktop`, environment
   `local`, and templates `brain-vm`, `pepper-vm`, `claude-vm` (no brain), which replace the
   three guests' `default.nix`. Pepper's allowlist is now the pepper brain's egress, and
   omni-laptop's `allowedDomains` reads it from the template. All four toplevels are the same
   derivations as before. How it differs from the above:
   - Templates take `modules` of their own, first in a guest's list: `claude-vm` has no brain
     but has a base config.
   - Guests keep their own `memorySize`/`cores`; the fleet only asserts they meet the
     capabilities' minimums. Valheim's 16 GiB is declared in step 7, when it leaves brain-vm,
     which runs it at 10 GiB today (declaring it now fails the build, as it should).
   - No `coding` capability yet: brain-vm's toolchain is still inside `brainVmConfiguration`.
     It comes out in step 3, for the slots.
3. **Slots and local fleetd.** The slot pool, `corkboard fleet spawn|list|attach|stop` on the
   host, no Worker yet. Done when `corkboard fleet spawn coding "run the tests in ~/x"` boots a
   slot, and a second spawn past the memory budget waits.

   **Done 2026-10-27.** Live: a `coding` spawn on the personal account fixed a failing test in
   a scratch repo in under five minutes and its commit came back by `fetch`; a second spawn
   waited on the budget with `agent-1` free, then took `agent-0` when the first ended. Slots are `agent-0`/`agent-1`
   (`my.agentVms.instances.<n>.slot`), system units nothing starts but fleetd, which may by a
   polkit rule. A slot's launcher builds `nixosConfigurations."<template>@<slot>"`
   (`fleet/guest/slot.nix` + the template) on an empty disk; the guest reads
   `/mnt/share/{task.md,claude-token,repo.bundle}`, runs `claude -p`, writes
   `/mnt/outbox/{result.json,work.bundle,exit}` and powers off. `fleet/fleetd/` is fleetd and
   `corkboard-fleet` (spawn, list, show, attach, stop, fetch, templates) — the CLI is
   `corkboard-fleet`, not `corkboard fleet`. Proxies are one unit per allowlisted VM now
   (`<name>-proxy`), not `services.tinyproxy`. Tested: `bun test fleet/fleetd` (scheduling),
   `nix flake check` (14), and fleetd + CLI end to end against a stand-in `systemctl`. Decided
   on the way:
   - Slots' egress is the union of every spawnable template's (`slotEgress`), because the
     proxy's filter is fixed at host build time. Per-spawn egress needs a filter fleetd can
     swap, later.
   - An agent's Claude Code login is an OAuth token (`claude setup-token`) at
     `~/.local/state/corkboard/fleet/claude-token`, copied into each spawn's share. It is the
     agent's runtime, not a brain's credential, so it doesn't count for approval, but the
     agent can read it.
   - The budget counts residents at their `memoryMax` while up, and each slot at its
     template's memory + 512 MiB. omni-laptop's is 21 GiB: one coding agent beside brain-vm and
     pepper-vm; a second waits.
   - The guest's store has a writable layer on its disk, so `nix build` works inside.
   - **Accounts (2026-10-27).** Each brain names a Claude account (`pepper` → `personal`,
     `work` → `work`), a token at `~/.local/state/corkboard/fleet/accounts/<name>`. A
     brain's template always runs as the brain's account; a brainless one runs as the brain
     that spawned it, or `--account`, or the host's `defaultAccount`. A brain's `shares` (the
     work vault) are mounted, shared and writable, in every agent of it spawned in a slot;
     `work-coding` and `pepper-coding` are the first such templates. Slot guests' `claude` is
     the owner's uid, or virtiofs refuses the writes (the outbox's too).
4. **The queue.** `spawns` in the Worker, the `spawn_agent` and `spawn_status` MCP tools, spawn
   tokens, the approval rule, and fleetd on the Worker's WebSocket. Done when a spawn made from
   the phone runs on the laptop.

   **Built 2026-10-27; waits on a deploy and a live run.** `cloud/src/fleet.ts`: spawns and each
   environment's templates in the user's object (`user.ts`), `/api/spawns` and
   `/api/fleet/environments` (owner only), and the MCP tools `spawn_agent`, `spawn_status`,
   `spawn_stop` for owner and assistant grants, so the phone's claude.ai connector can spawn.
   `fleet/fleetd/queue.ts` is fleetd's side, signed in as the bridge is (`bridge/cloud.ts`, now in
   the `fleet` package). Tested: `cloud/test/fleet.test.ts` (9), `fleet/fleetd/queue.test.ts`
   against a stand-in Worker, and the slot guest builds. How it works, and where it differs from
   the above:
   - fleetd `PUT`s its manifest's templates as its environment; the Worker applies the rule from
     those, so it needs no Nix. A spawn goes to the first environment that runs its template, or
     the one named.
   - Every spawn makes a card, on the board named or a `fleet` board made on first use, with the
     agent `<template>-<id>` queued on it. A project board's root is the repo the agent works
     in, and its commits are fetched back as `fleet/<id>` there without asking.
   - No WebSocket of its own: fleetd listens on `/api/live`, which now also carries
     `{ type: "spawn" }`, and looks every minute besides. Claims and reports are REST.
   - The spawn token is minted at claim, a card token for the spawn's card, handed to the guest
     as `/mnt/share/mcp.json` (corkboard's MCP server, `--mcp-config`) and revoked when the spawn
     ends. The Worker's host is in every slot's egress (`mkFleet`'s `corkboardHost`).
   - The Worker logs each state on the card; done moves it to review, failed raises attention.
   - Approval is `POST /api/spawns/:id/approve` or `corkboard-fleet approve <id>`; no button in
     corkboard yet. A brain's spawn is reachable only from code until step 6 (the rule is tested
     there).
   - The CLI's `spawn` stays local, not through the Worker: `corkboard-fleet queue` shows the
     Worker's, `list` this machine's (claimed ones included).
   - A brain template's spawn gets no brain token yet, so its hooks have no memory; the memory
     plan's step 4 adds it to the claim.
5. **The cloud environment.** The droplet on NixOS with `fleetCloud`; OCI outputs for `oci`
   capabilities; the egress proxy pod. Pepper's resident agent moves there; `pepper-vm` on the
   laptop is retired. The token mint that writes `/var/lib/pepper/corkboard-token` writes a
   Kubernetes Secret instead.
6. **Pepper spawns.** Pepper's grant gains `spawn_agent`. Done when Pepper spawns a `coding`
   agent in the cloud without asking, and a credentialed spawn shows up as an attention card
   and only runs once accepted.
7. **Split the work brain.** Valheim becomes its own template (`work` + `valheim`, local only),
   spawned when wanted; the resident work brain drops to `coding`'s size.

Steps 1–3 touch nothing Pepper depends on. Step 5 is the first one that changes Pepper.

---

## Open

- **The droplet.** Size and current OS, and whether anything else runs on it. k3s + gVisor +
  Pepper wants about 2 GiB; 1 GiB is too tight. NixOS on it means `nixos-infect` or a DO custom
  image.
- **Kata later?** Only if the droplet type exposes nested virtualization, which DO droplets are
  not known to. gVisor until then.
- **How spawned agents end.** Proposal: on the agent's own `done` (it writes its result to the
  card), on `corkboard fleet stop`, or at a per-template timeout (default 2 h).
- **The work brain's queue.** Pepper's spawns go through the Worker; the work brain's heartbeat
  would need a corkboard grant of its own to spawn. Not needed until something asks for it.
