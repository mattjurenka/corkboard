-- opencode as a corkboard agent kind: `opencode acp` under the bridge
-- (bridge/acp.ts, lib/acp/opencode.ts), its session a buffer of
-- corkboard.acp's. It has no tools of its own for asking and notifying, so
-- corkboard-ui's ask and notify are its.

local M = {
  name = "opencode",
  label = "opencode",
  exe = "opencode",
  events = "acp",
  tools = { ask = "ask", notify = "notify" },
}

function M.prompt(buf, text) return require("corkboard.acp").prompt(buf, text) end

function M.cancel(buf) return require("corkboard.acp").cancel(buf) end

-- The last usage record's context in its transcript (lib/acp/transcript.ts).
local function context(path)
  local fd = path and vim.uv.fs_open(vim.fn.expand(path), "r", 0)
  if not fd then return nil end
  local size = vim.uv.fs_fstat(fd).size
  local text = vim.uv.fs_read(fd, math.min(size, 256 * 1024), math.max(0, size - 256 * 1024)) or ""
  vim.uv.fs_close(fd)
  local used
  for line in text:gmatch("[^\n]+") do
    if line:find('"type":"usage"', 1, true) then
      local r = vim.F.npcall(vim.json.decode, line)
      if type(r) == "table" and type(r.used) == "number" then used = r.used end
    end
  end
  return used
end

M.read = {
  context = context,
  background = function() return {} end,
}

return M
