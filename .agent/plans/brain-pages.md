# A brain that knows where it is: projects, pages and open items

**Written:** 2026-11-16 · **Decided (Matt):** build it in the order below, steps 1 and 2 first.

Today a brain has one log for the whole account and one long-term memory note, and every session
starts with the same context wherever it runs: a session in `~/corkboard` was given the Stable
brain's soul and its notes on Verse's game servers. Nothing from a session reaches any note but
`memory`, by design (lib/memory/consolidate.ts: a transcript can only ever reach the log). The
vault's notes stopped changing when the brain-vm agent that wrote them stopped (2026-10-30).

What makes a brain useful is the right context in a session before the first message, and an answer
to "where was I, what did we decide". So the memory is shaped by project.

---

## The shape

| Layer | What | Written by |
|---|---|---|
| Episodes | sessions' transcripts | the hooks (as now), with the session's project |
| Log | dated bullets, each with its project | the consolidator, from an episode |
| Pages | one per project (and later person, decision); the core (soul, user, memory) | a nightly compile from the log |
| Open items | owed by Matt or by an agent, per project, open or closed | the consolidator; a session that does one closes it |

- **A project is a repo.** Its name is the basename of the main worktree's root (a corkboard
  worktree of `~/corkboard` is `corkboard`), found from the session's directory by the hook. Not a
  repo, no project.
- **The context is scoped.** The core, then the project's page, its open items and its log of the
  last week; of the rest of the log, only today's. Without a project, as before.
- **Pages are compiled, never authored.** Each claim cites the entries it came from, so a page can
  be checked and rebuilt from the log. The compile writes only pages (`project-<name>`, …), each
  over the version it read; never the soul or the user.
- **Newer wins.** Facts carry their day; a contradiction keeps the newer and moves the older to the
  page's history. A page untouched for weeks is shown as stale rather than as current.
- **Shown.** The memory view gets a day's "learned": page diffs, items opened and closed.

---

## Steps

1. **Projects on the log.** The hook sends `project` with an episode and with `/memory/context`;
   episodes keep it, and the consolidator writes it on each entry. Old entries have none.
2. **Context by project.** `Search.context` with a project: the core, `project-<name>` if there
   is one, the project's log of the last week, today's log elsewhere, then the rest as before.
3. **Open items.** Records `item:<id>` { project, owner, text, opened, closed? }; the flush prompt
   returns items opened and closed beside its bullets; the context shows the project's open ones;
   `items_close` for a session.
4. **Pages.** The rollup compiles `project-<name>` pages from the week's log, with citations;
   `memory` shrinks to what is the account's, not a project's.
5. **Learned today.** In the memory view (views/Brains.tsx).

Fleet slots' hooks (fleet/memory-hooks.nix) send no project until a slot knows its repo.
