# corkboard memory: one memory per brain, in the Worker, for every agent

**Written:** 2026-10-27 · **Status:** proposal, nothing decided.

Today the two brains remember in two unrelated ways. The work brain keeps Markdown in
`~/second-brain/vault` (SOUL/USER/MEMORY, `daily/`, a local FTS+embedding index), written by
hooks inside brain-vm and built for one writer. Pepper has corkboard notes in the Worker
(`UserDO.notes`, FTS5) but nothing loads them at session start or writes them at the end, and no
daily log. Spawned agents (`work-coding`, `pepper-coding`) can reach neither safely: the vault
breaks with two writers, and Pepper's notes need a token a slot doesn't have.

This plan moves memory into corkboard's Worker as a service every agent uses the same way,
whichever VM or cloud sandbox it runs in.

---

## What the field says works

- **Don't compress away the source.** Systems that keep raw episodes and retrieve over them match
  or beat summarising ones; summaries are views, not the record (EDU baseline, arXiv 2511.17208).
  Keep every transcript; derive everything else from it.
- **Simple tools go far.** A Letta agent with only grep/open over a file of history scored 74% on
  LoCoMo, above Mem0's graph variant at the time. Agents are good at search-and-read; give them
  that rather than a bespoke memory DSL.
- **Facts change; keep the change.** Zep/Graphiti marks a superseded fact invalid (bi-temporal:
  when it was true, when we learned it) instead of deleting it. Cloudflare's Agent Memory does the
  same with topic keys and forward-pointing supersession chains.
- **Hybrid retrieval, fused.** Cloudflare's pipeline runs FTS, exact key lookup, raw-message FTS
  and vector (plus HyDE) in parallel and merges with reciprocal rank fusion, newest first on ties.
  Do date arithmetic in code, not in the model.
- **Consolidate offline.** "Sleep-time" passes (Claude Code's auto-dream, the second brain's own
  08:00 reflect) dedupe, prune and fold logs into curated memory. They must be the only thing
  rewriting curated memory, or concurrent rewrites lose data.
- **A small core is always in context.** Letta's core blocks, the second brain's SOUL/USER/MEMORY:
  a few KB injected at start, everything else retrieved.
- **Benchmarks are soft.** Vendor LoCoMo/LongMemEval numbers vary 30–90 points by who ran them and
  which judge; LoCoMo has known answer errors. Choose on architecture and our own use, not scores.

Cloudflare's Agent Memory (private beta, April 2026) is close to this design and runs on the same
primitives. We build our own now with a compatible shape (`ingest`, `remember`, `recall`,
`list`, `forget`), so switching to it later is a backend change, not a client one.

---

## Design

```
 any agent (brain-vm, pepper-vm, a slot, a cloud sandbox)
   SessionStart hook ── GET  context ───────────┐
   tools: memory_recall / memory_remember / …  ─┤  MCP, brain-scoped token
   SessionEnd/PreCompact ── POST episode ───────┤
                                                ▼
                       Worker ── MemoryDO "brain:<name>" (one per brain, SQLite)
                                   episodes   raw transcripts, append-only (big ones in R2)
                                   entries    daily-log lines: time, who, text, episode
                                   memories   fact | event | instruction | task,
                                              topic key, valid_from, invalid_at, superseded_by
                                   docs       core + knowledge notes (SOUL, USER, MEMORY,
                                              Decisions/…), versioned, 409 on a stale write
                                   fts + Vectorize index per brain (Workers AI embeddings)
                                                ▲
                consolidator (a fleet template, on the brain's account) ┘
                  extract → verify → classify → supersede; daily rollup; curate MEMORY
```

**One writer per brain, by construction.** A Durable Object runs one request at a time, so every
write to a brain's memory is serialised in its DO. The vault's lost-append problem goes away:
agents never rewrite files, they append episodes and entries, and only the consolidator rewrites
curated docs, through versioned writes that refuse a stale base.

**What agents do.**
- At start, a hook fetches `context`: the core docs plus the last N days' entries within a token
  budget, as Markdown. This replaces `session-start-context.py` and gives Pepper the start-up
  loading it lacks.
- During a session: `memory_recall(query)` (hybrid search, fused, with dates resolved),
  `memory_remember(text, kind?)` (an entry now, a memory after consolidation), `memory_read(doc)`,
  and `memory_grep` for the plain-text case Letta showed matters.
- At the end and before compaction, a hook posts the transcript as an episode. That's all: no
  summarising inside the VM, so a slot that dies mid-task loses nothing it sent.

**Consolidation.** Extraction needs a model. Rather than add an API key to the Worker, it runs as
a fleet template (`<brain>-consolidate`) spawned by the Worker's queue (fleet step 4) on the
brain's own subscription account. It reads new episodes through MCP and writes memories and
docs back through the same versioned API. Workers AI does only embeddings (cheap, in-Worker,
asynchronous after a write). A Worker cron spawns it after a quiet period and at 04:00 (the day
turnover dayplan uses).

**Brains and grants.** Memory is per brain, not per user: `brain:work` and `brain:pepper` are
separate DOs and separate indexes. A token carries one brain; the Worker stamps it, as fleet's
ownership rule says. Spawn tokens get `recall` + `remember` + episode upload for their brain,
nothing more, so a `pepper-coding` agent can finally use Pepper's memory without the Pepper grant.
`soul` stays owner-only; `goal` stays Pepper-only.

**Obsidian stays the UI.** The bridge mirrors each brain's docs and daily entries to Markdown on
disk (`~/second-brain/vault` for work), and pushes your edits back as versioned writes; a
conflict becomes a `.conflict.md` beside the file instead of a silent overwrite. The vault stops
being the source of truth and becomes a working copy.

---

## Build order

1. **MemoryDO and the API.** Episodes, entries, docs (versioned), FTS. MCP tools `memory_context`,
   `memory_recall` (FTS only), `memory_remember`, `memory_read`, `memory_grep`. Pepper's existing
   notes migrate into `brain:pepper` docs. Done when Pepper's day-plan session starts with its
   context loaded and its transcript arrives as an episode.

   **Built 2026-10-27; waits on a deploy.** `cloud/src/memory.ts` (class `Memory`, one per
   `<user>/<brain>`), its tools in `mcp.ts` (`memory_context`, `memory_recall`, `memory_remember`,
   `memory_grep`; `note_*` now on the brain, and `note_write` takes a `version`), and
   `/memory/context` and `/memory/episodes` in `api.ts` for hooks. Pepper's notes move over on
   the brain's first open; the user object keeps its copy, unwritten. Hooks are
   `fleet/memory-hooks.nix` (`lib.fleet.memoryHooks`), installed in pepper-vm's managed settings.
   Decided on the way: every grant but a card's is Pepper's brain for now; a newer transcript of a
   session replaces an unconsolidated older one, since a resumed phone chat resends it each turn.
2. **Import the work brain.** The vault's Memory/ and knowledge folders become `brain:work` docs,
   `daily/` becomes entries; second-brain's hooks call the Worker instead of writing files.
   brain-vm keeps its local index until step 3. Done when a brain-vm session and a `work-coding`
   spawn both log the same day with nothing lost.
3. **Vectors and fusion.** Vectorize per brain, Workers AI embeddings, RRF over FTS + key + vector,
   deterministic dates. Retire second-brain's `memory_index.py`/`memory_search.py`.
4. **The consolidator.** Extraction into typed memories with supersession, the daily rollup into
   MEMORY, on the brain's account via the fleet queue. Retire `memory_flush.py` and
   `memory-reflect`.
5. **The Obsidian mirror** in the bridge, both ways.

Steps 1–2 depend on nothing in the fleet plan; step 4 needs its step 4 (the Worker's queue).

---

## Open

- **Work data in your Cloudflare account.** Stable's mail summaries, decisions and team notes
  would live in a personal Worker. That may need your employer's OK; if not, `brain:work` could
  run in a separate Cloudflare account or stay local, with the same API on the bridge.
- **Workers AI for extraction too?** Cheaper and always on, but weaker than Claude; worth trying
  only if the fleet-run consolidator proves too slow to start.
- **Episode retention.** Keep raw transcripts forever (the research's advice) or age them into R2
  after consolidation.
- **Cloudflare Agent Memory** when it leaves beta: adopt it as the backend if it can do per-brain
  profiles, export, and our grants.
