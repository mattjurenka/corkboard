# corkboard agents: Codex, Gemini CLI and opencode beside Claude Code

**Written:** 2026-11-10 · **Asked:** other agents and models, not just Anthropic: Codex CLI, Gemini
CLI and opencode as agents on cards and in the fleet, and the background `claude -p` jobs on any
provider. **Decided:** the default agent is the brain's (its `agent` and `model`), overridden per
card or session; Pepper is a brain like any other and can run on any kind. **2026-11-11:** hybrid:
Claude Code stays in its terminal with its hooks and the mod; Codex, Gemini CLI and opencode come
in over ACP (the Agent Client Protocol), drawn in a corkboard conversation buffer.

Today Claude Code is the only agent, and corkboard leans on six things of its: how it's started,
its hook events, its transcript, its own tools, its mod, and its accounts. This plan puts an
**agent kind** between corkboard and each of those, so a card, a brain or a session can name
`claude`, `codex`, `gemini` or `opencode`, and moves the one-shot model calls behind one `think`
that any provider answers.

---

## Where Claude Code is today

| Seam | Where | What it relies on |
| --- | --- | --- |
| Start | `nvim/lua/corkboard/claude.lua` `start()` | `claude --settings <json> --append-system-prompt --mcp-config= --plugin-dir`, `--name`, `--resume` (restore.lua), `CLAUDE_CODE_OAUTH_TOKEN` |
| State | `nvim/hooks/claude-session.lua` → `agents.lua` `event_state`/`settle` | SessionStart, UserPromptSubmit, Pre/PostToolUse, PermissionRequest, Notification (`notification_type`), Stop; `transcript_path`, `session_id`, `tool_name`, `agent_id` |
| Background work | `agents.lua` `finished_tasks`, claude-session.lua | `<task-notification>` in the transcript, ScheduleWakeup |
| Context and handoff | `context.lua`, claude-session.lua, slot.nix's loop | Anthropic `usage` fields on the transcript's last assistant record |
| Cost | `usage.lua`, `usage/transcript.lua`, `sessions.json` | `~/.claude/projects/*.jsonl`, `CLAUDE_CONFIG_DIR` |
| Phone and away | `bridge/transcript.ts`, `conversation.lua` | Claude Code's JSONL records, AskUserQuestion's `questions` |
| Notifying and asking | `claude-notification.lua`, `web/src/attention.ts`, prompts in claude.lua/agents.lua | PushNotification, AskUserQuestion |
| Memory | `claude-memory.lua`, `fleet/memory-hooks.nix` | SessionStart/PreCompact/SessionEnd, `transcript_path` |
| The mod | `nvim/claude-plugin/` (corkboard-ui) | Claude Code's plugin API: the ledger, say/emote/show, Pepper's work and hand-off |
| Accounts | claude.lua `account_for`, `fleet/fleetd/fleet.ts` ACCOUNTS, slot.nix `/mnt/share/claude-token`, pepper | `claude setup-token` OAuth tokens per brain |
| One-shot calls | `autopilot.lua` `think`, `bridge/propose.ts`, `bridge/node/consolidator.ts`, slot.nix `think`, pepper's usage review | `claude -p --tools "" --strict-mcp-config --setting-sources "" --system-prompt(-file) --json-schema --output-format json` → `structured_output`/`result` |
| Fleet tasks | slot.nix | `claude -p --output-format json`, `stream-json` in/out for chats, `--dangerously-skip-permissions` |
| Names | `CORKBOARD_AGENT=claude` (mcp/board.ts), `card.agent = "claude"`, `vim.b.corkboard_claude*`, "Claude Code" labels, the `claude` VM user | |

---

## The agent kind

One Lua module per kind under `nvim/lua/corkboard/agent/`, behind one table, and its TypeScript
twin in `lib/agent/` for the bridge and fleetd. `claude.lua` becomes the `claude` kind plus what
is common (the tab, the terminal, click-to-open, the TermClose handling), and is renamed
`session.lua`. The rest of corkboard asks the kind, never `claude` directly.

```lua
---@class corkboard.AgentKind
---@field name string            -- "claude" | "codex" | "gemini" | "opencode"
---@field label string           -- "Claude Code", "Codex", "Gemini CLI", "opencode"
---@field exe string
---@field command fun(o: { prompt: string, mcp: table, task: string?, name: string?, resume: string? }): string[], table  -- argv, env
---@field events "hooks" | "acp"   -- how its state reaches agents.lua
---@field transcript fun(ev: table): string?   -- its session file
---@field read table             -- { context(path), cost(path), records(path) } in corkboard's shape
---@field auth fun(account: string): table     -- env for the account's credential
---@field tools { ask: string?, notify: string? }
```

**Events, not hooks.** Every kind's events reach `agents.lua` as corkboard's own:
`start`, `turn`, `tool` and `tool_done { tool_name }`, `permission`, `asking { question }`,
`waiting`, `settled`, `notice`, with `session` and `transcript` (stage 1 has these; `end` and
`compact` come with a kind that needs them). `hooks/claude-session.lua` becomes
`hooks/session.lua`, Claude Code's adapter, turning its hook payload into those; the ACP client
turns `session/update`s into the same. `event_state` reads only corkboard's names.

**Transcripts in corkboard's shape.** `read.records` gives the phone's records (`you`, `agent`,
`tool`, `question`), `read.context` the last request's input tokens, `read.cost` tokens in and
out by model. `bridge/transcript.ts`, `usage.lua` and `context.lua` take them from the kind.
Cost uses a price table by model in `lib/model/prices.ts`, since only Claude Code's transcripts
come with Anthropic's.

**MCP is the common ground.** The corkboard, corkboard-memory and corkboard-ui servers already
are MCP, and all three CLIs take MCP servers. What is a Claude Code tool today becomes a corkboard
MCP tool for the others:

- `ask` (the user's question, with options) in corkboard-ui: the card's attention and the phone's
  question, as AskUserQuestion is now. Claude Code keeps AskUserQuestion.
- `notify` in corkboard-ui: what PushNotification does, for the kinds without it.
- `show`, `say`, `emote`: already MCP-shaped in the mod; served by corkboard-ui itself, so they
  need no plugin.

Background work (`<task-notification>`, ScheduleWakeup) is Claude Code's alone: the other kinds
go from `working` to `ready` with no `background`.

---

## The kinds

### claude

What corkboard does now, behind the interface: its own TUI in a terminal, `events = "hooks"`.
Also takes a brain's `provider`: Claude Code with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`
on an Anthropic-compatible endpoint (LiteLLM, OpenRouter, Ollama), so other models run with every
corkboard feature.

### ACP: codex, gemini, opencode

ACP is JSON-RPC on the agent's stdio, with corkboard as its client. One client (`lib/acp/`, run
by the bridge, the session's stream relayed to Neovim and the phone) takes the place of an
adapter per CLI:

| | How |
| --- | --- |
| Start | `gemini --acp`, `opencode acp`, `codex-acp` (the adapter that wraps Codex); `initialize`, then `session/new { cwd, mcpServers }`: corkboard's MCP servers handed over the same way for every kind |
| Prompt | `session/prompt`; corkboard's system prompt where the agent takes one (**verify** per agent: Gemini's `GEMINI_SYSTEM_MD`, opencode's `instructions`, Codex's `developer_instructions`), else as the first turn's preamble |
| State | `session/update`: `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`; the prompt's response (`stopReason`) is `settled` |
| Permission | `session/request_permission`, a request corkboard answers: from the conversation buffer, the card or the phone. Codex has it too, through the adapter |
| Context, cost | `usage_update` (`used`, `size`, optional cumulative `cost`; stable since 2026-06) |
| Transcript | corkboard's own: the bridge writes the session's updates to a JSONL in corkboard's record shape, which the phone, usage and context read |
| Resume | `session/load` (**verify** each agent advertises `loadSession`) |
| Cancel | `session/cancel` |

The view is a corkboard buffer, not the agent's TUI: the conversation as `conversation.lua`
draws a fleet session's now, a prompt line, tool calls folded, a permission request as a choice.
Monospace and box-drawn, as the rest of corkboard.

ACP has no compaction event, and per-turn token counts are still a draft: context handoff reads
`usage_update`, and the agent compacts on its own when it does.

---

## One-shot calls: `think`

One function in `lib/think.ts`, and its Lua twin in `nvim/lua/corkboard/think.lua`, for
autopilot, propose, the consolidator, slot.nix's `think` and Pepper's usage review:

```ts
think({ system, input, schema?, model?, tools?: [] }): Promise<{ text: string; json?: unknown }>
```

- **Providers.** `g:corkboard_think` / `CORKBOARD_THINK` name one as `<provider>:<model>`:
  `claude:sonnet` (the CLI, the machine's login, as now), `codex:<model>`, `gemini:<model>`,
  `opencode:<provider/model>`, or `openai:<model>@<base url>` for any OpenAI-compatible endpoint
  (OpenRouter, LiteLLM, Ollama, vLLM), with its key from the brain's credentials.
- **The HTTP way first.** An OpenAI-compatible `/chat/completions` with `response_format:
  json_schema` needs no CLI and no login, so the cloud node and the droplet can think without
  Claude Code. The CLI ways stay for using a subscription instead of an API key.
- **Schemas** go to the provider when it takes one (Claude `--json-schema`, Codex
  `--output-schema`, OpenAI `response_format`), and into the prompt otherwise; the answer is always
  checked against the schema, with one retry.
- No SDK: `fetch` and `spawn`, as the bridge does everything now.

---

## Choosing the agent

- **Brains** get `agent` (the kind) and `model`, beside `account`. The default brain's default
  is `claude`.
- **Cards**: `card.agent` already exists and is always `"claude"`. The board's `a` gives the
  brain's; `A` (or the card's menu) picks a kind. `agents.lua`'s grant, worktree and prompt are
  kind-neutral already, apart from naming AskUserQuestion.
- **New session** (`<C-.>`, the sidebar): a row per kind on PATH ("Codex here", "Gemini CLI
  here") beside the fleet's templates.
- **Fleet templates** get `agent`. slot.nix installs that kind's CLI and runs its headless form
  (`codex exec`, `gemini -p`, `opencode run`) where it runs `claude -p` now; chats over
  stream-json stay Claude Code only until a kind has an equivalent.
- **Accounts** become `{ kind, credential }`: fleetd's ACCOUNTS keeps tokens per account and
  kind, written to `/mnt/share/<kind>-credential`; the VM user becomes `agent`.

---

## What the others won't have

- **The mod.** The ledger, the cards and Pepper's plan drawn in the terminal are a Claude Code
  plugin. The others are drawn in corkboard's conversation buffer; corkboard's own views (board, phone, fleet) work the same.
  Pepper's VM session already runs without it (guest.nix starts it with no `--plugin-dir`), so
  Pepper can be any kind: what it needs is its prompt, the corkboard and memory MCP, the memory
  hooks on its session's start and end, and the usage review through `think`.
- **Background state.** No task-notifications or wakeups: `working` → `ready` only.
- **Compaction**: ACP doesn't say when an agent compacts; handoff goes by `usage_update`.
- **Cost** is the agent's `usage_update.cost` where it gives one, else estimated from tokens
  and the price table.

---

## Stages

1. **Done 2026-11-11.** **The seam, Claude only.** `agent/claude.lua`, `session.lua`, corkboard's event names, the
   readers behind the kind, `card.agent` read rather than assumed, `vim.b.corkboard_agent*`
   (keeping `corkboard_claude*` readable for restore). No behaviour changes; tests pass as they
   are. Rename `claude-session.lua` → `session.lua` (and the untracked test with it).
2. **Partly done 2026-11-11.** **`think`.** `lib/think.ts` and `think.lua`, the claude and OpenAI-compatible providers;
   autopilot, propose, the consolidator and slot.nix move over. The node can think on an API key.
   Done: `lib/think.ts` (claude, openai, openrouter, ollama; `<provider>:<model>[@<base>]`);
   brains' `model` and `model_key` (a hold, its secret read on the node; app.ts checks both) in
   the Brains view and form; the node's consolidator thinks as each brain says
   (consolidator.ts's `brainThink`); propose.ts on `think` (CORKBOARD_PROPOSE_MODEL). Left:
   autopilot (its reviewer runs tools in the worktree, so it stays on `claude -p`; its
   tool-less calls could ask the node to think as the board's brain, the key never leaving it),
   slot.nix's `think` (the Worker's consolidation job), Pepper's usage review in ~/pepper.
3. **Claude Code on other models.** A brain's `provider`/`base_url`: the cheapest way to other
   models with everything working.
4. **ask and notify in corkboard-ui**, so a kind without AskUserQuestion and PushNotification
   still reaches the card and the phone.
5. **The ACP client**: `lib/acp/`, in the bridge, with opencode first (native ACP, many
   providers): sessions, permissions, `usage_update`, the transcript corkboard writes.
6. **The conversation view** in Neovim and on the phone, for an ACP session.
7. **Gemini CLI and Codex** on the client: each only its command, its prompt, its auth.
8. **The fleet**: `agent` on templates, the CLIs and adapters in the guest image, credentials per
   kind; slot.nix's chats over ACP for every kind instead of stream-json.

Each kind's spike (its **verify** items, against the version nixpkgs has) comes before its stage.

---

## Open questions

- ~~An API key per brain or one for the account?~~ Per brain, the model too (Matt, 2026-11-11).
- Does cost from a price table belong on the usage view next to the transcript's real cost, or
  apart from it?
