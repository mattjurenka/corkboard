-- The kinds of agent corkboard runs: one module each under agent/, behind
-- the same table (.agent/plans/agents.md), so the rest of corkboard asks the
-- kind and never names Claude Code itself.
--
---@class corkboard.AgentKind
---@field name string                 -- what cards and brains call it: "claude"
---@field label string                -- what the UI calls it: "Claude Code"
---@field exe string                  -- what must be on PATH to run it here
---@field events "hooks" | "acp"      -- how its state reaches corkboard.agents
---@field command fun(o: table): string[], table  -- its argv and env (agent/claude.lua's says what o holds)
---@field read { context: fun(path: string?): integer?, background: fun(path: string?): table }
---@field tools { ask: string, notify: string }  -- its own tools for asking and notifying, else corkboard-ui's
---@field prompt? fun(buf: integer, text: string)  -- sends a prompt to its session, where a terminal paste won't

local M = {}

M.DEFAULT = "claude"

local KINDS = { claude = true, opencode = true, agy = true, codex = true }

-- An ACP kind's system prompt, before the session's own: corkboard-ui's
-- ask and notify in place of Claude Code's AskUserQuestion and
-- PushNotification (agent/claude.lua's NOTIFY_PROMPT).
M.PROMPT = table.concat({
  "You are running inside corkboard.",
  "Whenever you need the user to decide, approve or do something, and when you finish a task that took more than a minute or two, call corkboard-ui's notify; it reaches their desktop when they are not looking.",
  "When you have a question for the user, ask it with corkboard-ui's ask, with options where there are some, rather than in your reply: it reaches them on their card and phone.",
  "Whenever you have something for the user to look at (a screenshot, image, plot, PDF), show it with corkboard-ui's show rather than giving its path.",
}, " ")

-- The kind called name (nil: the default), or nil and why not.
function M.get(name)
  name = name or M.DEFAULT
  if not KINDS[name] then return nil, "no agent called " .. name end
  return require("corkboard.agent." .. name)
end

-- Every kind, the default first.
function M.all()
  local names = vim.tbl_keys(KINDS)
  table.sort(names, function(a, b)
    if (a == M.DEFAULT) ~= (b == M.DEFAULT) then return a == M.DEFAULT end
    return a < b
  end)
  return vim.tbl_map(M.get, names)
end

-- Whether kind can run here: on PATH, and an ACP kind only under the
-- bridge, which runs it.
function M.runs_here(kind)
  return vim.fn.executable(kind.exe) == 1 and (kind.events ~= "acp" or require("corkboard.cards.cloud").enabled())
end

-- The kinds that can run here, the default first.
function M.here() return vim.tbl_filter(M.runs_here, M.all()) end

-- corkboard-ui's own server (hooks/ui-mcp.lua) for buf's session, as ACP's
-- session/new takes an MCP server on stdio: ask and notify for a kind
-- without its own, and the mod's show, say and emote.
function M.ui_server(buf)
  local hook = vim.api.nvim_get_runtime_file("hooks/ui-mcp.lua", false)[1]
  if not hook then return nil end
  return {
    name = "corkboard-ui",
    command = vim.v.progpath,
    args = { "--clean", "--headless", "-l", hook },
    env = {
      { name = "NVIM", value = vim.v.servername },
      { name = "CORKBOARD_BUF", value = tostring(buf) },
    },
  }
end

-- The kind a session's terminal runs, nil when it runs none.
function M.of(buf)
  local name = vim.b[buf].corkboard_agent
  return name and M.get(name) or nil
end

return M
