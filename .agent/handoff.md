# Handoff: the fleet and corkboard memory, 2026-10-27

**For:** the next session picking this up. **Plans this continues:**
`.agent/plans/agent-fleet.md` (agent VMs) and `.agent/plans/memory.md` (one memory per brain in
the Worker). Read both before changing either area; each step's status is written under it.

Everything below is committed, in `~/corkboard` (last `723aded`) and `~/nixosconfig` (last
`aa5a2eb`); nixosconfig's `result` symlink is the only untracked file, and isn't ours. omni-laptop
was switched after the accounts change and again after the memory hooks; the Worker
(`corkboard.matthewjurenka.workers.dev`) was last deployed as version `bd7fe71c`.

---

## Where things are

### Fleet (agent-fleet.md): steps 1–3 done

- Slots `agent-0`/`agent-1` run spawnable templates (`coding`, `work-coding`, `pepper-coding`)
  via `fleetd` and `corkboard-fleet` (`fleet/fleetd/`). Live-tested: a `coding` spawn fixed a
  failing test and its commit came back by `fetch`; a second spawn waited on the 21 GiB budget.
- **Accounts:** each brain names a Claude account (`pepper` → `personal`, `work` → `work`). Tokens
  from `claude setup-token` live at `~/.local/state/corkboard/fleet/accounts/{personal,work}`
  (mode 600; both exist). A brain's template always runs as its account; a brainless one as the
  spawning brain's, `--account`, or `defaultAccount` (`personal`).
- **Brain shares:** `work-coding` mounts `~/second-brain/vault` read-write at `/mnt/vault`. That
  vault was built for **one writer** (see "Risks"). `work-coding` has never been run.
- Slot guests' `claude` user is uid 1002 (`mkFleet`'s `ownerUid`), or virtiofs refuses writes.
- **Next:** step 4, the queue in the Worker (`spawns`, `spawn_agent` MCP tool, spawn tokens,
  approval, fleetd on a WebSocket). The memory plan's step 4 needs it.

### Memory (memory.md): steps 1–3 deployed

- `cloud/src/memory.ts`: Durable Object `Memory`, one per `<user>/<brain>`; the brains are
  `pepper` and `work` (`BRAINS`). It holds versioned notes (409 on a stale `version`), a log of
  entries by day (the day turns over at 4am Phoenix), and session transcripts ("episodes",
  whole, a newer upload of a session replacing an unconsolidated older one).
- **Grants:** a `pepper` token works in Pepper's brain; a `brain` token (`POST
  /api/tokens/brain {brain}`) in its brain; owner/assistant OAuth in Pepper's; card tokens have
  no memory. `goal` notes are visible only to a brain's own agents (`hiddenFor` in `mcp.ts`).
  Pepper's three goals were re-kinded from `memory` to `goal`.
- **MCP tools:** `memory_context`, `memory_recall`, `memory_remember`, `memory_log`,
  `memory_grep`, plus the old `notes_search`/`note_*` (now on the brain; `note_write` takes
  `version`).
- **Hook routes:** `GET /memory/context`, `POST /memory/episodes`; owner-only `?brain=` on
  `/api/notes`, `POST /api/memory/entries`, `GET /api/memory/vectors`.
- **Hooks:** `fleet/memory-hooks.nix` (`lib.fleet.memoryHooks`) is in pepper-vm's managed
  settings: SessionStart prints the context; PreCompact and SessionEnd post the transcript. They
  use `/var/lib/pepper/corkboard-token`, so only day-plan and phone sessions have memory.
- **Work brain import:** `bridge/memory-sync.ts` (`corkboard-memory-sync work
  ~/second-brain/vault`, a 15-minute user timer in nixosconfig's `modules/features/corkboard.nix`)
  copies the vault **one way**: 71 notes, 2257 log entries on the first run; a second run changed
  nothing. The vault stays the source of truth until step 5.
- **Step 3 (just deployed):** `cloud/src/vectors.ts` embeds notes (≈1500-char titled chunks) and
  entries with `@cf/baai/bge-m3` into Vectorize index `corkboard-memory`, one namespace per brain,
  from the object's alarm after each write. Recall fuses FTS on notes, FTS on entries, vectors, and
  the entries of any day the question names (`cloud/src/dates.ts`).

## Unfinished: check these first

1. ~~The vector backfill~~: done 2026-10-27. Work's backfill was stuck on bge-m3's per-call token
   limit (texts × longest); `embed()` now batches for it, and both brains are fully embedded.
2. **pepper-vm's hooks haven't run live.** After a day-plan Pepper session, `GET
   /memory/episodes?brain=…` (owner) or as Pepper should list its transcript, and the session
   should have opened with its goals.
3. Tests: `cd cloud && bun run test` (109 pass; "something prevents Vite server from exiting"
   appeared once the AI/Vectorize bindings were added and is harmless), `bun test fleet/fleetd`
   (12), `nix build .#checks.x86_64-linux.fleet` (17).

## Risks and known bugs

- **Several writers on the vault.** brain-vm and any `work-coding` spawn write
  `~/second-brain/vault` at once; second-brain's `append_to_daily_log` and `MEMORY.md` rewrite
  replace whole files, and its `flock` almost certainly doesn't work across VMs. Until brain-vm
  writes through the Worker, consider making `work-coding`'s vault share read-only (one line in
  nixosconfig `modules/features/fleet.nix`, `shares.vault.writable`). The user hasn't decided.
- **brain-vm and slots don't reach `brain:work` yet:** nothing gives them a brain token. Slots
  get one with spawn tokens (fleet step 4); brain-vm needs one in its drop box, renewed (tokens
  last 7 days).
- `nvim/lua/corkboard/plan/claude.lua` deletes `/var/lib/pepper/corkboard-token` on exit
  without checking it's its own, so it can pull the phone bridge's token mid-turn (`bridge/
  phone.ts` checks; this doesn't).
- pepper-vm's usage-review prompt says `note_search`; the tool is `notes_search`.
- Pepper's context is mostly its three goal notes (about 4 KB); no `soul`/`user` notes exist yet.

## Working with this user

- They drive; confirm before production deploys, data changes and anything that runs long.
  The safety check once blocked a deploy chained onto other commands: run deploys on their own.
- Matching the repo: comments say what and why in plain sentences; the plans carry status under
  each step. Commit messages: a plain subject, a paragraph, the Co-Authored-By line.
- corkboard's UI stays TUI-like (monospace, grid, box-drawn), except the Ctrl/Alt+Space tool
  picker, which is a normal dialog in the editor's font and colours, at their request.
- Never `pkill` bridge processes: the bridge hosts these sessions.
