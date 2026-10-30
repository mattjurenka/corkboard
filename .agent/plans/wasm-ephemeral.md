# corkboard all in the browser: wasm Neovim with the board's repo in memory

**Written:** 2026-10-30 · **Decided:** a page can run with no machine of its own. Neovim (wasm/,
in a Web Worker) has an in-memory filesystem holding the opened board's repo, cloned from its
Forgejo remote when the page opens and gone when it closes. Claude sessions run on real hosts
(the fleet), never in the browser; terminals run on real hosts over ssh.

Today ?wasm runs Neovim in the page with the bridge as its machine: every file call is a blocking
XHR to `/host/fs`, and processes, terminals and watches go to `/host/lua` (bridge/wasm.ts). This
plan adds a second machine for corkboard.wasm, the page itself, and takes the bridge out.

```
browser
 ├─ Web Worker: nvim.wasm ── HOSTFS /work, /plugins, and /dev/corkboard-host
 │     │   (blocking calls: a message, the answer in shared memory, machine/link.ts)
 │     ▼
 ├─ Web Worker: the machine (machine/machine.ts) ── in-memory files (vfs.ts):
 │       /work/<repo> with .git, /plugins; git (isomorphic-git, git.ts)
 └─ page ──https/wss──▶ Worker ── boards, cards, the fleet's queue (sessions)
                          ├──── git: Forgejo's smart HTTP, for clone and push
                          └──── ssh: TCP to a host's port 22 (terminals)
```

## What needs a process today, and where it goes

| corkboard Lua                                   | ephemeral                                         |
|-------------------------------------------------|---------------------------------------------------|
| `git rev-parse/status/check-ignore` (init.lua)  | isomorphic-git on the MEMFS repo, in the worker   |
| `claude` (claude.lua jobstart)                  | a fleet session on a host; edits reach it by push |
| `:terminal`, shells (terminal.lua, restore.lua) | ssh to a host, its pty drawn by vt.lua as now     |
| day plan `apply` (plan.lua), fleet `ssh`        | hidden in this mode                               |
| file watches (fs_event)                         | none needed: only Neovim writes the MEMFS         |
| board/cards over the bridge's socket            | straight to the Worker                            |

## Status (2026-10-30)

Steps 1 and 2 work end to end, against a stand-in Worker (git http-backend) and a test bridge:
`?wasm=ephemeral&repo=owner/name` clones in well under a second, corkboard starts clean on the
clone, and edits show in the file tree's git marks. The Worker's route (cloud/src/git.ts) is
tested but **not deployed**: cloud/ also held another session's uncommitted work.

- The page is still served by a bridge, which also gives it `/wasm/manifest`, the plugin bundle
  and `/api/git` (passed to the Worker with the bridge's sign-in). Step 3 moves these to the Worker.
- The clone is shallow (depth 1), so the first commit isn't known: `project_commit` is nil.
- git is emulated for what corkboard runs (machine/git.ts); anything else, and every other
  program, exits 127. No push yet (step 4 needs write access on the Forgejo token).

## Steps

1. **The repo in memory.** A Worker route proxies Forgejo's smart HTTP for the board's remote
   (owner tokens only, as cloud/src/git.ts). The worker clones with isomorphic-git into MEMFS
   before Neovim starts; the corkboard plugin and snacks come as a static snapshot with the page
   (the bridge's wasm.snapshot, made at build time). `?wasm=ephemeral&board=<key>`.
2. **A page machine for corkboard.wasm.** `/dev/corkboard-host` answered in the worker instead
   of by /host/lua: `git` ops by isomorphic-git, the rest refused as "no processes here", so
   corkboard.wasm's shims fail the way a missing binary does.
3. **Boards without the bridge.** The page talks to the Worker for boards, cards and live
   events (bridge/boards.ts's job today), with the corkboard sign-in.
4. **Sessions on hosts.** Starting Claude queues a fleet session for the board (the Worker's
   queue, fleetd); the session panel attaches to it as the fleet view does. Before it starts,
   the page commits and pushes its edits to a branch, which the host clones.
5. **Terminals over ssh**, to every host, the laptop too (decided 2026-10-30):

## How a terminal reaches a host over ssh

The browser can't open TCP itself, and the laptop is behind NAT, so no host is dialed directly.
Every host is reached the same way: the host dials out.

```
page: ssh client ──wss──▶ Worker: Relay DO (one per host) ◀──wss── host: bridge/fleetd
   (key: non-extractable                 pairs the two sockets          └──TCP──▶ 127.0.0.1:22
    WebCrypto Ed25519)                   and copies bytes                          (sshd)
```

- The ssh client runs in the page, so the session is ssh end to end: the Worker and the relay
  see only ciphertext, and the host's sshd does the authentication.
- The host keeps one wss open to its Relay DO (as the bridge already does to the Worker for
  sessions, bridge/remote.ts). A page asking for a terminal makes the DO tell the host, which
  opens a second socket for that terminal and a TCP connection to its own sshd.
- Each browser makes its own key, which can't leave it. Its public key is added to the host's
  authorized keys from the host's side (bridge settings, or nixosconfig), never from the page.
- The laptop needs sshd listening on 127.0.0.1 only (services.openssh in nixosconfig with
  `listenAddresses`, no firewall port). Today it runs none.
- The droplet and fleet VMs use the same relay, so no host needs port 22 open for this.
