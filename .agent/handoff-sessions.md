# Handoff: Claude Code sessions from the phone and the fleet view, 2026-10-28

**For:** the next session picking this up. **Continues:** `.agent/handoff.md` (fleet and memory,
2026-10-27) and `.agent/plans/agent-fleet.md`. Read this first; the older handoff is still right
about everything it covers.

**Nothing here is committed.** The working tree also holds another session's uncommitted work
(`claude.lua`'s `title`, `init.lua`, `web/src/components/Sidebar.tsx`, `web/src/store.ts`, and
more from before). Commit only once the user asks, and look at the diff before staging.

---

## What the user asked for, in order

1. Open and type into any running Claude Code session from the phone. **Done, deployed.**
2. Fleet as its own tab on the phone (a `now` / `fleet` bar along the foot). **Done, deployed.**
3. A terminal on the phone that's the same session as the laptop's. Built with tmux and xterm.js,
   then **removed**: one process has one terminal size, so the laptop shrank whenever the phone
   was used, and the user wouldn't accept that. Replaced by item 4.
4. Corkboard's own phone view: the conversation drawn from the session's log at the phone's
   size, the laptop untouched. **Done, deployed.**
5. The machine's hostname as the environment name instead of `local`. **Code done.** See
   "Open".
6. Start a new Claude Code session in a VM, for each host and choosing a VM type, from the
   phone; and follow and type into it from the laptop too. **Code done, Worker deployed, app
   installed. Blocked on a second NixOS rebuild.** See "Open".
7. "I want you to be able to start sessions": a `start_session` MCP tool. **Written, not
   tested, not deployed.** The user stopped the test run, then asked for this handoff.

---

## How it works

**Sessions are served by "bridges".** Anything that has Claude Code sessions connects to the
user's live socket as a bridge (`/api/live?bridge=<id>&machine=`). It reports its sessions
whenever they change, and answers what's asked of one over that socket. The Worker
(`cloud/src/user.ts`, the "Bridges" section) keeps each bridge's list only while its socket is
open, and relays everything else.

- **`bridge/sessions.ts`:** the shared part, `serve(id, environment, source)`. It reports the
  list, answers `screen` and `say`, and serves streams: a stream follows one session's log with
  `bridge/transcript.ts` (`Follower`, 500 ms poll), sending the last 200 items first, then each
  new one, as `{ items, reset }`. A source gives `list()`, `watch()`, `say()` and optionally
  `screen()`.
- **`bridge/remote.ts`:** the laptop bridge's source, the Neovim pages' sessions (`away.ts`'s
  list). The key is `"<page>-<buf>"`; the id is `<hostname>-<port>`, e.g. `omni-laptop-7777`.
  `screen` and `say` go to the page's Neovim (`nvim/lua/corkboard/away.lua`'s `M.screen` and
  `M.say`, answered with an `"answer"` notification). A session's log path comes from
  `vim.b[buf].corkboard_claude_transcript`, which the SessionStart hook sets.
- **`fleet/fleetd/sessions.ts`:** fleetd's source, its running interactive spawns. The key is
  the spawn id; the bridge id is `fleetd-<hostname>`. `say` appends stream-json to the slot's
  `inbox.jsonl` in the share; esc appends a `control_request` interrupt. State is `starting`,
  then `working` or `idle`, worked out from messages sent against `result` events.
- **Guest (`fleet/guest/slot.nix`):** if `/mnt/share/session` exists, it runs
  `tail -F inbox.jsonl | awk 'until END' | claude -p --input-format stream-json --output-format
  stream-json --verbose --dangerously-skip-permissions`. `~/.claude/projects` is symlinked into
  the outbox so fleetd can follow the log live. On `END`, Claude Code finishes its turn and
  exits; the guest bundles commits and powers off.
- **fleetd stop:** for an interactive spawn, writes `END` first and only stops the unit after
  120 s. Exit 0 after a requested stop counts as `done`.

**Worker routes** (`cloud/src/api.ts`):

| Route | What it does |
|---|---|
| `GET /api/sessions` | Every connected bridge and its sessions |
| `GET /api/sessions/:bridge/:key` | `{ lines, width }`, a page session's screen |
| `POST /api/sessions/:bridge/:key/say` | `{ text?, keys? }`; keys are `enter esc up down tab shift-tab ctrl-c` |
| `GET /api/sessions/:bridge/:key/attach` | WebSocket: `{type:"out", data}` (a JSON string of `{items, reset}`) until `{type:"end", why}`; stream sockets get no other broadcasts |
| `POST /api/spawns { …, interactive: true }` | An interactive spawn (session); `task` is optional, as its first message |
| `DELETE /api/fleet/environments/:name` | Removes a stale environment; no broadcast |

**Phone (`android/…/corkboard/`):**

- `Fleet.kt`: sessions under their machine or VM, and `+ session` on each fresh environment
  that has templates.
- `NewSession.kt`: choose VM type, board with a repo, and first message.
- `Sessions.kt`: `Conversation` for sessions with a log, and `Lines` (the old screen poll) for
  the rest. Answer buttons press `1`/`2`/`3` for a permission prompt, or an AskUserQuestion's
  options.
- `Screen.Session(bridge, key)`, `Screen.NewSession(environment)`.

**Laptop:**

- `nvim/lua/corkboard/fleet.lua` lists `fleet.bridges` (from `fleet_get`, minus this bridge's
  own, `self`). VM sessions go on their slot's card, another machine's on a host card. Enter
  opens `nvim/lua/corkboard/conversation.lua`, which shows `agent://session/<bridge>/<key>` in a
  tab: `i`/`a`/`o` say something, `<C-c>` sends esc, `R` follows again, `q` closes.
- The bridge side is `bridge/boards.ts`'s `fleet_follow`, `fleet_unfollow` and `fleet_say`,
  with events `conversation` and `conversation_end` routed through `fleet.cloud_event`.

---

## Deployed state

- **Worker:** version `f1df1fc3`. It has everything above *except* `start_session`.
- **Phone app:** installed over adb (`192.168.0.129:42753`; the phone's port changes, so ask).
  It is the build with `NewSession.kt`.
- **Dev bridge (`corkboard-dev.service`, port 7777):** restarted on the current code. The
  **installed bridge** still runs old code, so its sessions are missing from the phone until
  it's restarted, and that only lasts once its package is rebuilt.
- **omni-laptop's NixOS:** rebuilt once with this work, but **fleetd crash-loops**:
  `Cannot find module './sessions'`. Its package in `flake.nix` copies an explicit file list.
  **Fixed in the working tree** (added `fleet/fleetd/sessions.ts`, `bridge/sessions.ts` and
  `bridge/transcript.ts`) and checked with `nix build "path:$PWD#fleet"`: every entry point
  resolves. **The user has to rebuild again**: `nix flake update corkboard` in `~/nixosconfig`,
  then their rebuild (needs sudo; Claude can't). That rebuild also applies their own
  uncommitted niri changes in nixosconfig.
- While fleetd is down, the Worker still lists environments `local` (stale) and `cloud`.

---

## Open, in order

1. **After the user rebuilds:** check that fleetd is up (`systemctl --user status
   corkboard-fleetd`), that `/api/fleet/environments` has `omni-laptop`, and that
   `/api/sessions` has `fleetd-omni-laptop`. Then `DELETE /api/fleet/environments/local`.
   Check the `cloud` environment with the user before touching it.
2. **First live VM session.** Start one (phone `+ session`, or `POST /api/spawns` with
   `interactive: true`, `template: "coding"`, `board: "home-matthew-corkboard"` and a short
   message), and confirm:
   - it shows under its slot, the conversation streams, and a reply typed on the phone arrives;
   - esc interrupts;
   - stop brings commits back as `fleet/<id>`.

   None of this has run in a VM yet. The pipeline itself was tested locally with a real
   `claude` (two turns in one session, then `END`, exit 0).
3. **`start_session` MCP tool** (`cloud/src/mcp.ts`, before `spawn_status`): type-checks. Its
   test in `cloud/test/fleet.test.ts` was **not written** (the edit was rejected). Write it, run
   `bunx vitest run` in `cloud/` (last full run: 128 passed), then deploy. Ask before deploying.
   Note it can only *start* a session: there's no MCP tool yet to read one or type into one.
4. **Permission buttons on the phone** (`1 yes` / `2 always` / `3 no`) press digits into
   Claude Code's menu. Untested.
5. **Sessions on another machine's page** (`?host=`), and VM-attached sessions, have no log on
   the bridge's machine. They fall back to the screen view (`Lines`).

---

## Gotchas learned this session

- **The bridge hosts this session.** Restarting `corkboard-dev.service` ends the Claude session
  doing it: schedule it with `systemd-run --user --on-active=5 …` and say so first. Never
  `pkill` bridge patterns (see memory).
- **`nix build .#…` only sees git-tracked files**, and the new files are untracked. Use
  `nix build "path:$PWD#fleet"`, as nixosconfig does (`url = "path:/home/matthew/corkboard"`).
- **A new file fleetd imports must also go in the `fleet` package's fileset and `cp` list in
  `flake.nix`.** That's what broke the rebuild.
- **Reinstalling the APK** can leave its accessibility service unbound (setup screen comes
  back): turn corkboard's service off and on in Android settings.
- **A WebView in Compose** needs `MATCH_PARENT` layout params, or its page lays out 0 high.
  It's no longer used, but noted in case it comes back.
- **The phone's WebView debugger** is reachable: `adb forward tcp:9333
  localabstract:webview_devtools_remote_<pid>`, then CDP `Runtime.evaluate`. Also `adb exec-out
  screencap -p` for screenshots.
- **`fleet/fleetd/queue.test.ts`** now pins `CORKBOARD_FLEET_ENVIRONMENT=local`, since the
  default became the hostname.
- **The session stream** reuses the Worker's relay. The phone never sends on it; typing goes by
  `/say`.

## Checks

- `cd cloud && bunx vitest run` (128 passed before `start_session`).
- `bun test fleet/fleetd` (16 passed).
- `bunx tsc --noEmit -p .` (no errors in `bridge/` or `fleet/`).
- `nix develop .#android -c gradle -p android assembleDebug --offline -q` (builds).
- Headless Neovim checks for `away.lua` and the fleet view with a stubbed bridge; the scripts
  were in the session's scratchpad and weren't kept.

---

## Update, 2026-10-29: sessions run on the droplet

- The `cloud` environment (the droplet) now has a slot, `cloud-0`, and the template
  `cloud-coding`. A session started from the Worker booted, answered, took a second message,
  was interrupted by esc and ended on stop. Droplet details are in the `droplet` memory.
- **The inbox is now a directory**, `share/inbox/0`, `1`, ... (`post()` in
  `fleet/fleetd/sessions.ts`), not an appended `inbox.jsonl`. The VM module's virtiofsd runs
  `--cache=always` (hardcoded in nixpkgs), so the guest never saw appended lines; a new name it
  does see. That bug applied to the laptop's slots too, which take the fix at their next
  rebuild (nixosconfig's corkboard lock is updated, the laptop guest's derivation is
  otherwise unchanged).
- `slot.nix`'s units take `claude`'s own group, not `users`; the droplet's guest's claude is in
  `corkboard` (gid 985). nixosconfig `modules/features/fleet.nix` has the matching change.
- A session whose last turn was interrupted exits 1, so stopping it shows `stopped`, not
  `done`.
- Test cards TASK-2 to TASK-5 on the `fleet` board are from this; TASK-2 and TASK-3 failed.
