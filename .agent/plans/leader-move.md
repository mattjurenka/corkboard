# Moving the leader from the UI: joining a machine, and Forgejo that follows

**Written:** 2026-11-07 · **Goal:** move the account's leader from the droplet to omni-laptop, then
to a new droplet, with nobody running a CLI. Item 2 (a move takes effect at once) is done in
4d85926, not yet deployed. This plan covers item 1 (joining a machine) and item 3 (Forgejo under the
node, forge-on-leader.md pieces 1–5). **Proposed**, decisions below.

## 1. Joining a machine

A laptop with the desktop app and a headless server join differently, but the steps after that
are the same.

- **Server: an invite, not a code typed back.** The palette's "Add a server" (on any full
  device) makes a one-time invite: a pairing mailbox opened ahead of time, plus a secret that
  stands in for the SAS check, since only the approver and the invite know it. The window shows a
  cloud-init `#cloud-config` to paste into the provider's "User data" box. It installs the server
  package and writes the invite to `/etc/corkboard/invite`. On first boot the node redeems the
  invite. The approving device seals the root to it, the same way as `approve`, but with no
  question asked. The new device then shows up in Settings → Devices with a name the user picked
  when they made the invite. The invite expires after 30 minutes or on first use, and Devices
  lists pending invites so one can be taken back.
- **Laptop: the desktop app's first run.** Today a signed-out first start silently makes a local
  account (app.ts:104-108), which is what makes `e2ee pair` refuse later. Instead, the first
  start asks one question: a new account, or join one. "Join" shows `pairNew`'s code and the SAS
  in the app, to be approved from "Pair a device" on another device. omni-laptop is already in
  the account, so the test doesn't need this, but a new laptop does.
- **The server package.** The new droplet needs Nix anyway, since fleetd's slot VMs are built
  with it. So the cloud-init installs Nix and then a `corkboard-server` profile (the node, fleetd
  and claude-code) with two units:
  - `corkboard-node`, as today's hand-made one, run as its own user;
  - `corkboard-fleetd`.
  
  fleetd's device setup (`device`, then `relay-device`, then `device cert`) becomes the node's
  job: a node on the same machine certifies its fleetd as a relay-only device on first start, so
  fleet.json's `node.device` is written for it. NixOS hosts get the same thing as
  `nixosModules.server` (`services.corkboard.node` beside `services.corkboard.fleet`).
- **What a new leader still needs**, shown as rows in Devices' detail for the leader, each with
  its own action rather than an explanation:
  - Claude login, for consolidation: an "Add Claude login" action pastes a token into the
    node's env file over its channel (it isn't sent anywhere else);
  - calendar: re-linked from the new leader with the existing calendar link flow;
  - the passphrase, if the account key has one: asked once, kept in the node's env.

## 3. Forgejo under the node

forge-on-leader.md's pieces 1–5, in its Order steps 2–5:

1. The forge handler in serve.ts (the gate's logic, on `/forge/` channels), and the bridge's
   loopback proxy, which replaces `gitProxy`.
2. Forgejo as the node's child process. It starts when the node leads and stops when the node
   hands off, with its state in `<state>/node/forge/`. The droplet's `/var/lib/forgejo` moves in,
   and the hosted gate stops.
3. fleetd's proxy to its slots. The guest credential helper goes.
4. Snapshots: a `git bundle` per repo on each push, and the DB dumped every 10 minutes, both
   sealed to the account and kept on the relay. A new leader restores the latest before starting
   Forgejo, and an old leader that's still up pushes a last DB dump when it hands off. That way
   a planned move loses nothing; only a crash loses up to 10 minutes of issues and PRs.

## Decided (2026-11-07, Matt)

1. **Forgejo follows the leader.** The laptop runs it while it leads, restored from the snapshots.
2. **git.corkboard.fyi goes through the Worker to the leader's tunnel.** It follows the leader
   with no DNS change, with browser traffic in plaintext through the Worker (trust-us).
3. **The server package is cross-platform, not tied to an OS.** The node and fleetd are built as
   one self-contained binary (`bun build --compile`) for linux x64/arm64 and macOS. It ships the
   way the desktop app does: deb, rpm, tarball, AUR and Homebrew. A first start installs its own
   service (a systemd unit, or launchd on macOS). The cloud-init that "Add a server" makes runs one
   install script that picks the right one for the machine, so Nix isn't installed on it.
   - Slot VMs still need KVM and a guest image. fleetd downloads the release's prebuilt guest
     images (kernel, initrd, store image) rather than building them. Where it can't run VMs (no
     `/dev/kvm`, or macOS), fleetd runs and leads with no slots, and the fleet view shows the host
     with no capacity.
   - NixOS keeps `nixosModules.server`, built from source.
