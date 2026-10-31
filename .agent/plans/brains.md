# Brains as data: a list you can change, not a constant

**Written:** 2026-10-31. Steps 1, 2, 3 and 5 built the same day (commits 0c118f3 and after); step 4, the fleet, is next.

Today a brain is hardcoded in four places that have to agree by hand:

- `BRAINS = ["pepper", "work"]` (cloud/src/memory.ts), which every brain name is checked against
  (api.ts `brainNamed`, the export's loop).
- Grants: Pepper has a kind of its own (`{ kind: "pepper" }`) beside `{ kind: "brain", brain }`,
  its own token route (`/api/tokens/pepper`), and tools only it sees (`pepper: true` in mcp.ts);
  every grant but a card's works in Pepper's memory (`brainOf`).
- The fleet: brains in Nix (`services.corkboard.fleet.brains`: account, credentials, egress,
  shares), and a template per brain and VM type (`work-coding`, `pepper-coding`).
- Pepper's first-open backfill from the user's notes (memory.ts `open`).

This makes a brain a row in the user's object that the Worker owns, with a CRUD API, MCP tools and
a view, and makes everything above read it.

---

## The record

```ts
type Brain = {
  name: string;            // its id: /^[a-z][a-z0-9-]{0,31}$/, never changes (it keys the memory
                           // object, `<user>/<name>`, and its Vectorize namespace)
  title: string;           // what it's called: "Pepper", "Stable"
  description: string;     // what it's for; the first lines of its agents' context
  account: string | null;  // the Claude account its agents run as (a token name on each host)
  credentials: string[];   // what it holds, as labels: any makes a spawn *by a brain* wait for you
  egress: string[];        // hosts its agents may reach, besides their template's
  abilities: string[];     // tools beyond memory: "chat" (the phone's chat), "plans" (propose
                           // the day plan). What `pepper: true` means today.
  default: boolean;        // the brain your own sessions (owner/assistant grants) work in;
                           // exactly one, or none
  created: string;
  updated: string;
  archived?: string;       // set by delete; see below
};
```

Kept in `UserDO` as a `brains` table (name primary key, doc JSON), like environments and spawns.
The memory object is still made on first use; the record is what says the brain exists.

### Rules

- **Name** is fixed at creation. `title` is what changes when you'd want to rename.
- **Create** refuses a name in use (archived ones too, until purged).
- **Update** is a patch with the record's `updated` as its version: a stale one gets 409 with the
  record as it is, as notes do.
- **Delete archives**: the brain disappears from lists, spawns and grants, its tokens are revoked,
  and its memory is kept. `POST /api/brains/:name/restore` brings it back as it was.
  **Purge** (`DELETE /api/brains/:name?purge=<name>`, the name typed again) empties the memory
  object and its vectors and frees the name. Refused while a spawn of it is queued or running.
- **One default.** Setting `default` on one clears it on the others.

---

## The API (owner only, under the existing auth)

```
GET    /api/brains                    every brain (?archived=1 for those too), each with its memory's
                                      counts: notes, entries, episodes, last episode
POST   /api/brains                    { name, title, description?, account?, credentials?, egress?,
                                        abilities?, default? }
GET    /api/brains/:name
PATCH  /api/brains/:name              { ...fields, updated }  (name can't be patched)
DELETE /api/brains/:name              archive; ?purge=<name> to purge an archived one
POST   /api/brains/:name/restore
POST   /api/brains/:name/tokens       a token for its agents { ttl? }; replaces /api/tokens/brain and
                                      /api/tokens/pepper, which stay as aliases for a release
```

MCP tools, for the owner's and assistant's clients only: `brain_list`, `brain_read`,
`brain_create`, `brain_update`. Archiving stays out of MCP (as accepting a plan does): only the
user does it, in corkboard.

---

## What changes to read it

**Grants.** One kind, `{ kind: "brain", brain: string }`. Pepper's is the `pepper` brain with the
`chat` and `plans` abilities, so a tool's `pepper: true` becomes `ability: "chat"`, reachable by a
brain grant whose brain has it. Existing `{ kind: "pepper" }` tokens are read as
`{ kind: "brain", brain: "pepper" }`, so the droplet's keeps working. A grant whose brain is
archived is refused.

**Your own sessions.** `brainOf(owner | assistant)` is the default brain, not `"pepper"`. With no
default, the memory tools say so instead of writing somewhere.

**Memory.** `memoryOf` checks the record exists and isn't archived. The export dumps every brain's
memory, archived ones included. Pepper's backfill stays as it is: it only ever ran once.

**The fleet.** A brain stops being a property of a template and becomes one of a spawn:

```
spawn = template (the VM: coding, …) + brain? (who it works for) + shell? + size?
```

- `work-coding`/`pepper-coding` go; a spawn says `{ template: "coding", brain: "work" }`.
- The Worker stamps the spawn from the record: its `account`, its `egress`, and whether it needs
  approval (a brain spawning, and the brain has credentials). Who may spawn for a brain is the
  same rule: you, or the brain itself.
- At claim fleetd also gets **a token for the brain**, and puts it in the share. The slot guest
  installs the memory hooks (fleet/memory-hooks.nix) when it's there, so a brain's spawned agent
  starts with its context and its transcript becomes an episode (today it gets neither).
- What stays on the host is what only the host can know. `services.corkboard.fleet.brains` shrinks
  to **host bindings** keyed by brain name: `shares` (the work vault is a path on the laptop). A
  brain with no binding on a host runs there without shares.
- **Egress.** A slot's proxy filter is fixed when the host is built, so a brain's `egress` beyond
  the slot's allowlist can't be granted yet. A spawn whose brain asks for a host the slot can't
  reach is refused with the hosts missing, until fleetd can swap a filter per spawn. Not
  silently narrowed.
- **Accounts.** The account named has to have a token on the host (`accounts/<name>`); fleetd
  fails the spawn otherwise, as it does now.

---

## The view

A **Brains** tab in Neovim (`agent://brains`), with the browser's HTML over it as the other tabs
do. Box-drawn, monospace.

```
BRAINS                                    a new · e edit · d archive · <CR> its memory · R refresh
┌ pepper ─────────────────────────── default · personal ┐┌ work ──────────────────────────── work ┐
│ Personal assistant                                     ││ Stable                                 │
│ 412 notes · 3.1k entries · 88 episodes · 2h ago        ││ 71 notes · 2.3k entries · 0 episodes   │
│ google corkboard · chat plans                          ││ graph github google                    │
└────────────────────────────────────────────────────────┘└────────────────────────────────────────┘
```

- `<CR>` opens its memory: notes by kind, the log by day, episodes, with recall to search.
- `e`/`a` edit in a scratch buffer of the record as YAML-ish `key: value` lines, written on `:w`.
- `d` asks, then archives; archived brains show dimmed with `?archived`, and `u` restores.
- The fleet tab's spawn picker gains a brain choice, from this list.

---

## Build order

1. **The record and the API.** `brains` in UserDO, seeded on first read with `pepper` (default,
   personal, google + corkboard, chat + plans) and `work` (work, graph + github + google), so
   nothing changes for what exists. Routes, tests. `BRAINS` goes; `brainNamed` reads the table.
2. **Grants.** One brain kind, abilities for Pepper's tools, the default brain for your own
   sessions, the old token kind read as the new. Tested against the droplet's Pepper token.
3. **MCP tools and the Brains tab.**
4. **The fleet.** `brain` on a spawn, the record stamped on it, the brain token at claim, memory
   hooks in the slot guest, host bindings in place of brains in Nix, and `*-coding` templates
   retired.
5. **Archive and purge**, with the memory object emptied and its vectors deleted.

**Built 2026-10-31 (1, 2, 3, 5).** `cloud/src/brains.ts` and a `brains` table in UserDO; only
`pepper` is seeded (decided: every user starts with just Pepper; an existing `work` memory needs
its record made once, `POST /api/brains`). Each brain has a random `id` that its tokens carry, so
a purge-and-remake in the same second still locks old tokens out. Pepper's chat tools are the
`chat` ability; there is no `plans` ability, since no other tool was Pepper's alone. The view is
on three surfaces: the Brains tab (`nvim/lua/corkboard/brains.lua`, fourth pinned, with
`web/src/views/Brains.tsx` over it; `:AgentBrains`), the portal's `/brains`, and the Android
app's `brains` tab. `<CR>` edits, not "opens its memory": a memory browser is still to do.

Steps 1–3 change nothing a running agent sees. Step 4 is the first that changes spawns.

---

## Open

- **Delete:** archive by default with purge as a second, typed step (proposed), or a real delete?
- **Abilities:** generalise Pepper's tools as abilities any brain can have (proposed), or keep
  them Pepper's alone?
- **Default brain:** your own sessions work in one brain you pick (proposed: Pepper, as now), or
  in none unless a session says which?
- **The view:** a Neovim tab (proposed, in the TUI's style), or a page in the portal too?
