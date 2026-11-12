-- Gemini CLI as a corkboard agent kind: `gemini --acp` under the bridge
-- (bridge/acp.ts, lib/acp/gemini.ts), its session a buffer of
-- corkboard.acp's. It has no tools of its own for asking and notifying, so
-- corkboard-ui's ask and notify are its.

local M = {
  name = "gemini",
  label = "Gemini CLI",
  exe = "gemini",
  events = "acp",
  tools = { ask = "ask", notify = "notify" },
}

function M.prompt(buf, text) return require("corkboard.acp").prompt(buf, text) end

function M.cancel(buf) return require("corkboard.acp").cancel(buf) end

-- Its transcript is lib/acp/transcript.ts's, as opencode's is. Gemini sends
-- no usage_update, so its context reads as unknown; a restore starts it
-- afresh (lib/acp/kinds.ts's NO_RESUME).
M.read = require("corkboard.agent.opencode").read

return M
