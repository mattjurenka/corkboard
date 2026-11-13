-- Antigravity CLI as a corkboard agent kind: `agy acp` under the bridge
-- (bridge/acp.ts, lib/acp/agy.ts), its session a buffer of corkboard.acp's.
-- It has no tools of its own for asking and notifying, so corkboard-ui's
-- ask and notify are its.

local M = {
  name = "agy",
  label = "Antigravity",
  exe = "agy",
  events = "acp",
  tools = { ask = "ask", notify = "notify" },
}

function M.prompt(buf, text) return require("corkboard.acp").prompt(buf, text) end

function M.cancel(buf) return require("corkboard.acp").cancel(buf) end

-- Its transcript is lib/acp/transcript.ts's, as opencode's is. agy sends no
-- usage_update, so its context reads as unknown.
M.read = require("corkboard.agent.opencode").read

return M
