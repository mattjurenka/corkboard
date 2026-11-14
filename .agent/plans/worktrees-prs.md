# A worktree for every session, and pull requests to merge

Agents edit the user's working tree today: a <C-.> session, a hand-off from
Pepper and an ACP kind all run in the project directory (session.lua's
`start` passes no cwd). Only a card gets a worktree (agents.lua's
`worktree`, `card/<id>`), and its merge is a local `git merge` the user (or
autopilot's auto_merge) does from review.lua. Fleet spawns already push
`agent/<spawn>/work` to the forge and are told how to POST a pull request.

Decided (2026-11-12):

- **Every session gets a worktree**: <C-.>, hand-offs, cards, every kind,
  here or in the fleet. Nothing an agent does edits the user's tree.
- **An agent merges only after a review**: another session (or the
  autopilot reviewer) approves the PR first, or the user merges it. The
  author can't merge its own unapproved PR.

## Pieces

1. **Worktrees for sessions** (nvim). `agents.worktree` becomes
   `corkboard.worktree.make(root, name)`: under
   `data_dir("worktrees", path_key(root), name)`, on `agent/<name>/work`
   from the main checkout's HEAD. `session.start` makes one when given no
   cwd and the project is a repo, and keeps it on the buffer
   (`corkboard_worktree`, `corkboard_branch`) so restore (and Claude Code's
   `--resume`, which looks a session up by its cwd) starts in the same one.
   A card's is `agent/<id>/work`; a card already on `card/<id>` keeps its
   branch. The session's prompt says where it is and that it commits there
   and pushes to origin.
2. **PR tools** (bridge/node/mcp.ts, the node's MCP server, so every kind
   has them): `open_pr {title, body, base?}` from the caller's branch,
   `list_prs`, `read_pr {n}` (diff, reviews, checks), `review_pr {n, verdict:
   approve|changes, body}` and `merge_pr {n}`. They go to Forgejo through
   the node's forge (forge.ts) as the account. The caller's session and
   branch come from the MCP connection (the session's env, as
   CORKBOARD_CARD does now).
3. **The review rule** lives in the tools, not Forgejo: every agent is the
   account's one Forgejo user, and Forgejo neither lets a user approve its
   own PR nor tells sessions apart. `review_pr` writes a Forgejo review whose
   body ends in a marker naming the reviewing session; `merge_pr` merges only
   when the newest review from a session other than the PR's author is an
   approval of the PR's head commit, and the PR is mergeable. The user's
   merge (review.lua, or the forge's page) has no rule.
4. **Cards through PRs**: `submit_for_review` pushes the card's branch and
   opens or updates its PR, and keeps its number on the card (`pr`).
   review.lua's approve merges the PR (forge API) instead of `git merge`;
   send back is as now. autopilot's reviewer reviews with `review_pr`, and
   its auto_merge merges with `merge_pr`.
5. **After a merge**: the worktree is removed and the branch deleted (local
   and on the forge), and the main checkout fast-forwards to the new base
   if it's clean and on that branch. Archiving a card, or closing a
   session's tab for good, removes its worktree once nothing is uncommitted
   or unpushed; otherwise it says so and keeps it.
6. **The fleet**: spawns already push `agent/<spawn>/work`; they get the
   same tools, through fleetd's gateway with their grant. A template's grant
   needs `pull_requests: write` to open and review, and `contents: write`
   with the base in its refs to merge.

## How (worked out 2026-11-12)

- Piece 1 is in: nvim/lua/corkboard/worktree.lua (`make`, `linked`,
  `for_session`); session.start makes one unless via/attach/resume or
  `worktree = false`, or cwd is already a linked worktree (so a card's,
  which agents.lua makes, and a restore, which passes the worktree as cwd,
  aren't doubled); `vim.b.corkboard_branch` keeps the branch.
- Who's calling: the node's /mcp has no per-session identity (every local
  session shares ~/.local/state/corkboard/node/session-mcp.json, whose path
  is CORKBOARD_MEMORY_MCP_CONFIG; claude.lua and acp.lua both pass it).
  For a session with a branch, nvim writes a 0600 copy of it with headers
  `X-Corkboard-Branch` and `X-Corkboard-Repo` (owner/repo from origin) on
  the `corkboard` server and passes that path instead; mcp() reads them.
- Forgejo: the node reaches it with `toForge` (serve.ts; server.ts's
  `o.toForge`, as git.ts's gitViews uses `/api/v1/...`); add `forge` to
  mcp.ts's `Node` and pass `o.toForge` at server.ts's /mcp. PR_TOOLS in
  their own file (bridge/node/prs.ts), wired as FILE_TOOLS are.
- Reviews: Forgejo won't let a user approve its own PR, and every agent is
  the same user, so `review_pr` posts a COMMENT review whose body ends
  `corkboard-review: approve|changes <branch> <head sha>`; `merge_pr`
  wants the newest such line from a branch other than the PR's head to be
  approve at the current head sha, then POSTs `pulls/:n/merge` (Do: merge,
  delete_branch_after_merge, head_commit_id).

## Done (2026-11-13, uncommitted)

- Identity: worktree.lua's `mcp_config` writes a 0600 copy of the shared
  config under state_dir("session-mcp") with a `corkboard-forge` server
  (`/mcp?tools=forge`, the PR tools alone) carrying the headers, so a
  card's own `corkboard` server can't shadow it; session.start passes it as
  `node_mcp` to claude.lua and acp.lua.
- bridge/node/prs.ts (tests in prs.test.ts): open_pr (updates one already
  open from the branch), list_prs, read_pr, review_pr, merge_pr.
- Cards: submit_for_review takes `pr` (node: extra.pr; files: pr);
  review.lua merges a card with a pr through the bridge's `pr_merge`
  (the user's, no rule; refuses while the worktree has unpushed commits);
  autopilot posts its verdict with `pr_review` and auto-merges only after
  that lands, through the rule.
- After: worktree.lua's `finish` (fetch, remove, branch -D, ff the main
  checkout when clean and on base) and `drop` (archive from the board,
  kept when dirty or holding commits nowhere else).

Not yet: an agent's archive_card over MCP leaves the worktree (the node
can't reach it); a session's tab closed for good doesn't drop its
worktree; the fleet (piece 5) still POSTs PRs raw.

## Open

- A repo with no forge origin (another GitHub-only project): sessions still
  get worktrees; the PR tools say there's no forge, and merging is the
  local `git merge` review.lua does today.
- Who reviews by default: the autopilot reviewer when it's on, else the
  user, on the board's Review column as now.

## The Git tab (2026-11-13, uncommitted)

The tools' Git opens agent://git (nvim corkboard/git.lua, web
views/Git.tsx): every worktree of the project's repository and of each one
agents have worktrees of, ahead/behind origin's default branch, uncommitted,
unpushed, its PR and its session or card; the forge's open PRs with checks
and the newest other-session review (the bridge's git_forge, prs.ts's
overview); and the forge (version, latency, user, leader, pages via relay,
each repo's last CI run). <CR> goes to it, o its page, m merges, d removes a
worktree, r reloads.
