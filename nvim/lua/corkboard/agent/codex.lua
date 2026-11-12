-- Codex as a corkboard agent kind: `codex-acp`, the ACP adapter that runs
-- Codex, under the bridge (bridge/acp.ts, lib/acp/codex.ts), its session a
-- buffer of corkboard.acp's. It has no tools of its own for asking and
-- notifying, so corkboard-ui's ask and notify are its.

local M = {
  name = "codex",
  label = "Codex",
  exe = "codex-acp",
  events = "acp",
  tools = { ask = "ask", notify = "notify" },
}

function M.prompt(buf, text) return require("corkboard.acp").prompt(buf, text) end

function M.cancel(buf) return require("corkboard.acp").cancel(buf) end

-- Its transcript is lib/acp/transcript.ts's, as opencode's is.
M.read = require("corkboard.agent.opencode").read

return M
