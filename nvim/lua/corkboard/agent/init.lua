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

local M = {}

M.DEFAULT = "claude"

local KINDS = { claude = true }

-- The kind called name (nil: the default), or nil and why not.
function M.get(name)
  name = name or M.DEFAULT
  if not KINDS[name] then return nil, "no agent called " .. name end
  return require("corkboard.agent." .. name)
end

-- The kind a session's terminal runs, nil when it runs none.
function M.of(buf)
  local name = vim.b[buf].corkboard_agent
  return name and M.get(name) or nil
end

return M
