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
  brain's; `A` (and the card float's `A`) picks the brain and the kind in corkboard.columns
  (Brain │ Agent │ here, "no brain" last) and sets `card.agent` before it starts. `agents.lua`'s grant, worktree and prompt are
  kind-neutral already, apart from naming AskUserQuestion.
- **New session** (`<C-.>`, the sidebar): Brain │ Agent │ Where, corkboard.columns taking any
  number of columns. The agent column has a row per kind with somewhere to run: here when it's
  on PATH (an ACP kind only under the bridge), and for Claude Code the fleet's VMs and
  templates, till stage 8 gives templates their kind.
- **Fleet templates** get `agent`. slot.nix installs that kind's CLI and runs it over ACP
  (`fleet-acp`, tasks and chats alike) where it runs `claude -p`; Claude Code stays on
  stream-json (stage 8).
- **Accounts**: fleetd's ACCOUNTS keeps a credential per account and kind (`<account>.<kind>`
  beside Claude Code's `<account>`), written to `/mnt/share/<kind>-credential`; the VM user stays
  `claude`.

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
   (consolidator.ts's `brainThink`); propose.ts on `think` (CORKBOARD_PROPOSE_MODEL).
   2026-11-12: autopilot's intake and groom ask the node to think as the default brain (app.ts's
   `brains_think`, the key never leaving it), `claude -p` without the bridge; its reviewer runs
   tools in the worktree, so it stays on `claude -p`. slot.nix's `consolidate` (the Worker's
   plaintext consolidation) is gone, the node's consolidator being the one. Pepper's usage review
   stays a `claude -p` with the memory tools, on the brain's model as stage 3 gives it.
3. **Done 2026-11-12, on this machine.** **Claude Code on other models.** No new brain field: its
   `model` and `model_key` drive its sessions too. lib/think.ts's `sessionEnv`: for an endpoint,
   `ANTHROPIC_BASE_URL` (its base without /v1, the Anthropic side OpenRouter, Ollama, LiteLLM and
   vLLM serve), `ANTHROPIC_AUTH_TOKEN` (the key; Ollama's any), the machine's login blanked, and
   every model Claude Code picks set to the brain's; api.openai.com refused. For claude, its model
   and the key as an OAuth token or API key. app.ts's `brains_session` hands it out when a session
   starts (agent/claude.lua), so the key stays on the node till then. Pepper's VM: fleetd reads
   the node's `GET /api/node/brains/<brain>/session` (owner, sealed) each hour and writes it as
   shell exports to the resident's `sessionEnvFile`, which the guest sources over its Claude
   token (assistant.ts, fleet/pepper). Its proxy's allowlist has to have the endpoint's host.
   Fleet sessions on a brain's model are stage 8's, by the same route.
   Verified live 2026-11-12: `claude -p` with a fresh CLAUDE_CONFIG_DIR on Ollama's /v1/messages
   (qwen3:1.7b) ran two Bash calls and answered, its transcript as usual. Found: its
   `total_cost_usd` (0.07) is priced as Claude, so a brain's usage and cost read wrong.
4. **Done 2026-11-12, on this machine.** **ask and notify in corkboard-ui**, so a kind without
   AskUserQuestion and PushNotification still reaches the card and the phone. corkboard-ui is an
   MCP server of its own as well as the mod: `nvim/hooks/ui-mcp.lua`, stdio, run as `nvim -l`
   with `$NVIM` and `$CORKBOARD_BUF` as the hooks are, with `ask`, `notify`, `show`, `say` and
   `emote`. `corkboard.agent.ui_server(buf)` gives it in ACP's `mcpServers` shape for stage 5;
   a kind's `tools` names its own (claude's are AskUserQuestion and PushNotification). `ask`
   (`corkboard.questions`; `corkboard.ask` is vim.ui's box on the page) raises corkboard's `asking` event with AskUserQuestion's questions, so the
   card's attention, the page's notification and away mode follow as they do now; its answers
   come from away mode's `say` (away.lua sends them to it, not as keys) or from attending the
   card (`vim.ui.select`). It waits 50 s (under Codex's minute-long MCP timeout), then tells the
   agent to carry on, and a later answer goes as its next prompt (the kind's `prompt`, else a
   terminal paste). `notify` is corkboard.notification titled with the kind's label; `say` and
   `emote` go straight to the avatar (avatar.lua's `say`), since only Claude Code's log is read
   for them. Left for stage 5: the phone sees the questions from the transcript, so the ACP
   client writes an `ask` call as an AskUserQuestion record; and its system prompt tells the
   agent to use `notify` and `ask` (claude.lua's NOTIFY_PROMPT is Claude Code's).
5. **Done 2026-11-12, on this machine (opencode 2.2.5).** **The ACP client**: `lib/acp/`, in the
   bridge, with opencode first (native ACP, many providers): sessions, permissions,
   `usage_update`, the transcript corkboard writes. `AcpSession` (client.ts) speaks to `opencode
   acp` and raises corkboard's events; transcript.ts writes Claude-Code-shaped JSONL to
   `<state>/acp/<session>.jsonl`, which bridge/transcript.ts and the phone read unchanged;
   bridge/acp.ts runs a Neovim's sessions by buffer (`acp_*` ops through cards/cloud.lua), the
   model from the node's `brains_model`; `corkboard/acp.lua` is the buffer (a line view till
   stage 6), `agent/opencode.lua` the kind, and `<C-.>` has a row per kind this machine runs
   (`agent.here()`). Restore keeps an ACP buffer and resumes it with `session/load`.
   What opencode does, verified:
   - `initialize` advertises `loadSession`; `session/load` replays the history as updates
     (`user_message_chunk` with a `messageId`, tool calls) before it answers, which the view
     draws and the transcript doesn't write again.
   - Updates: `agent_message_chunk`/`agent_thought_chunk` with `messageId`; `tool_call` (name,
     title, kind, empty rawInput) then `tool_call_update` (rawInput in progress, then
     completed/failed with text content and rawOutput); `usage_update {used, size, cost}`;
     `available_commands_update`, `config_option_update`. The prompt's result is `{stopReason,
     usage}`; a model error (a provider's quota, say) is the prompt's JSON-RPC error.
   - Permissions: none asked by default. The user's config `permission` (`{"edit":"ask",
     "bash":"ask"}`; the schema now says `permissions`, the old key still works in 2.2.5) makes it
     send `session/request_permission` with `once`/`always`/`reject`; a reject fails the tool and
     ends the turn `cancelled`. After `session/cancel` the bridge refuses what's still asked, as
     ACP says the client must.
   - The system prompt is a file in `instructions` (removed when the agent ends). MCP servers go
     in the config's `mcp` with `codemode:false`: handed over in `session/new`'s `mcpServers`
     they sit behind one code-mode `execute` tool, their names only in its rawOutput.
   - An ask that stops waiting leaves the session asking after its turn settles (agents.lua),
     and the late answer is its next prompt.
   - opencode's own `question` tool is off (`tools: {question: false}`): it can't be shown to an
     ACP client, each call failing "couldn't be shown to the user in this client", and a small
     model loops on it rather than use corkboard-ui's ask.
   - opencode logs "mcp connected" before session/new answers, yet a prompt sent at once lacks
     the MCP tools (0–30 ms fails, 100 ms works). `Spec.settle` waits after session/new or load:
     1000 ms for opencode with MCP servers. A timing workaround, verified 3/3.
   - opencode 2.0.32, the flake's pin, never gives MCP tools to the model; 2.2.5 does.
   Verified live 2026-11-12 (2.2.5): a `permission: {bash: "ask"}` prompt answered with an
   option ran the shell; corkboard-ui's ask through MCP, written as AskUserQuestion with its
   result; a custom OpenAI-compatible provider in opencode's config (Ollama, a scripted
   endpoint). Not verified live: the brain's model handed over by bridge/acp.ts, and switching
   models.
   Found: bridge/acp.ts passes no `log`, so an agent's stderr is dropped and a failed start
   (codex's "Authentication required") shows in Neovim only as the buffer exiting. The board's `A` picks a card's brain and kind (see Choosing the agent),
   verified 2026-11-12 in a headless Neovim with the board and start stubbed.
6. **Neovim's part done 2026-11-12, on this machine (opencode 2.2.5).** **The conversation view**
   in Neovim and on the phone, for an ACP session. The fleet's view (conversation.lua) is shared:
   `attach(buf, o)` sets a buffer up as one (its keys, the prompt split under it, the page's
   composer when one is attached) with the source's handlers (`say`, `answer(n)`, `answers`,
   `interrupt`, `close`, `refollow`, `gone`). bridge/acp.ts follows the session's own transcript
   with bridge/transcript.ts's `Follower`, as the phone does, and draws at most every 40 ms:
   `corkboard.acp.view(buf, items, live)`, the new items and the words not yet flushed
   (`AcpSession.saying`), skipped while it only thinks. So a resumed session's history comes from
   the file, not the replay. A permission's options are answered with 1-9 in the view; a
   corkboard-ui ask is the view's question card, answered through `corkboard.questions`; how a
   turn ended (stopped, out of tokens, a failure) is a `note` item, which the page draws too.
   Verified live through a headless Neovim on the bridge's Acp: a prompt's › row, live words
   under ✻ working, the ● reply; a tool's └ result; a permission's 1; an ask's card and answer;
   C-c leaving the partial words and "— stopped"; /clear; resume; q and a wiped buffer each
   stopping the agent once. The phone needs nothing new: remote.ts lists the session's
   transcript, which the hub follows; what it says is the next prompt and esc stops the turn
   (away.lua through the kind); a question's answers go to `corkboard.questions`, and a
   permission's number, sent as text, answers it (`acp.prompt`), checked through `away.say`.
   Not yet tried on a phone.
7. **Wired 2026-11-12; spiked against stand-in APIs, no real turn yet (no Gemini or OpenAI
   credentials on this machine).** **Gemini CLI and Codex** on the client: `lib/acp/gemini.ts`
   and `codex.ts`, in `lib/acp/kinds.ts`'s `KINDS` beside opencode (bridge/acp.ts and the fleet
   both take them from there), and `agent/gemini.lua` and `agent/codex.lua`, which read their
   transcripts as opencode's does. Each file's header says what was verified. In short:
   - **Gemini CLI, replaced by Antigravity CLI the same day** (`lib/acp/agy.ts`, `agent/agy.lua`):
     Google stopped serving Gemini CLI's personal sign-in (AI Plus/Pro/Ultra) on 2026-06-18, and
     its `session/load` wrote over the session. **agy 1.5.3**, `agy acp`, with a real turn on an AI
     Plus login: corkboard's prompt in session/new's `_meta.antigravity.systemPrompt.append`
     (`Spec.meta`), the MCP servers in session/new as ACP's, stdio and HTTP, run without asking;
     the user's keyring login, or `GEMINI_API_KEY` signed in with `authenticate` (`Spec.auth`).
     ACP's `usage` on the prompt's result; `session/load` replays and keeps the prompt. The
     fleet pins 1.5.3 in slot.nix: corkboard's nixpkgs has 1.4.1, which has no `acp`.
   - **Codex 0.167.0 through codex-acp 2.1.1**: everything in `CODEX_CONFIG`: the prompt as
     `developer_instructions`, the MCP servers with `default_tools_approval_mode = "approve"`
     (handed over in `session/new` they ask every call), and the brain's model.
     `INITIAL_AGENT_MODE=workspace-write`, so what's outside it asks corkboard instead of
     Codex's "Guardian Review" model. A brain's model must be behind the Responses API (OpenAI,
     OpenRouter, LiteLLM, Ollama), given as the adapter's in-memory "gateway" auth: its
     "api-key" login would write `~/.codex/auth.json` over the user's ChatGPT login. Without
     either, `codex login` once. Resume and `usage_update` work. An MCP call's rawInput is
     `{server, tool, arguments}` and its rawOutput `{result: {content}, error}`, which
     transcript.ts unwraps.
   Verified live 2026-11-12, Codex 0.163.0 (the flake's nixpkgs) through codex-acp 2.1.1 in a
   headless Neovim on bridge/acp.ts, on qwen3:1.7b behind Ollama's /v1/responses as a brain's
   model: the prompt's › row, an exec_command row and its result, the ● reply, the turn settling.
   Found and fixed: its exec tool spawns `codex-linux-sandbox` from PATH, which nixpkgs' codex
   doesn't have ("No viable candidates found in PATH"); it's codex itself under that name
   (argv[0]), which slot.nix now links beside codex-acp. A host whose codex comes from nixpkgs
   needs the same. Found and fixed: a command Codex parses as a list, read or search comes with
   no rawInput, only a title ("List files"), which transcript.ts now writes as its
   `description`. Not tried: Codex's own `request_user_input` tool through ACP.
   Left: a real turn of each on its own service (Gemini, OpenAI), with the user's login or key.
8. **Done 2026-11-12; opencode and Codex booted in a slot.** **The fleet**: a template's `agent` (fleet/lib.nix's
   `agents`, Claude Code's by default; any other throws) goes into the manifest, fleetd and
   `fleet_get`, so `<C-.>` lists each template, and each VM running one, under its own kind.
   slot.nix installs the kind's CLI (`opencode`, `agy`, `codex-acp` wrapping nixpkgs'
   codex) with `fleet-acp`: fleet/guest/acp.ts on lib/acp/, which runs a task (one turn on
   task.md, its `result.json`) or a session (the inbox fleetd fills, each turn's end a result
   line in `events.jsonl`, its transcript in `outbox/projects/acp/`) so fleetd reads it as
   Claude Code's. Every permission is allowed, as Claude Code runs with
   `--dangerously-skip-permissions`. The brain's memory note (`/etc/claude-code/CLAUDE.md`) is
   its prompt. Credentials: fleetd's `accounts/<account>` stays Claude Code's token;
   another kind's is `accounts/<account>.<kind>`, KEY=value lines (`GEMINI_API_KEY`,
   `OPENAI_API_KEY`, which fleet-acp gives codex-acp as OpenAI's gateway) copied to
   `share/<kind>-credential`. fleet/tests.nix checks the default and a bad agent; slot guests
   for each kind evaluate, and the opencode one's task script builds (shellcheck) and its
   fleet-acp runs.
   Decided: Claude Code stays on stream-json in the slot rather than claude-code-acp, which
   would lose its hooks: the context handoff and the brain's memory hooks are Claude Code's
   alone, and an ACP kind's task is one session with no handoff. The VM user stays `claude`.
   A brain's model for an ACP kind in a slot (stage 3's route) isn't wired: the credential is
   the account's.
   Booted 2026-11-12: `t@slot` guests from mkFleet on the flake's locked nixpkgs, QEMU user
   networking in place of the tap, the host's endpoints at 10.0.2.2. opencode 2.0.32 on a
   scripted OpenAI-compatible endpoint (its credential `OPENCODE_CONFIG` naming a provider) ran
   its shell in the guest and wrote `result.json`, `exit` 0 and its transcript. Codex through
   codex-acp, its credential `DEFAULT_AUTH_REQUEST` at Ollama, ran exec_command in its sandbox
   (once slot.nix had codex-linux-sandbox) with the same outputs.
   Found: with no model given, Codex asks the gateway for its own default (`gpt-6.1-sol`), and
   sends that model's `additional_tools` input, which anything but OpenAI refuses; the test
   gave `CODEX_CONFIG` in the credential, which replaces corkboard's prompt and MCP servers.
   So a non-OpenAI gateway in a slot needs the model wiring above. Found: codex-acp hands a
   provider's error back as the agent's words and ends the turn `end_turn`, so `result.json`
   reads `is_error: false` with the error JSON as its result.
   Pins: opencode 2.0.32 (the lock's) never gives MCP tools to the model, 2.2.5 does; bumping
   nixpkgs for it breaks codex, which then isn't cached and fails building aws-lc-sys. A
   separate nixpkgs input for the agent CLIs is one way out (undecided).

Each kind's spike (its **verify** items, against the version nixpkgs has) comes before its stage.

---

## Open questions

- ~~An API key per brain or one for the account?~~ Per brain, the model too (Matt, 2026-11-11).
- Does cost from a price table belong on the usage view next to the transcript's real cost, or
  apart from it?
