-- How full a Claude Code session's context is, from its transcript. Used by
-- corkboard.agents in Neovim and by hooks/session.lua in the session
-- (a `nvim --clean -l`, which reaches this file by path, so it needs nothing
-- else of corkboard's).

local M = {}

-- Past the limit a session's context is worth starting fresh: every request
-- re-reads it all. At NUDGE of it the session is asked to write a handoff;
-- at STOP of it, it may do nothing else. g:corkboard_context_limit in
-- Neovim, CORKBOARD_CONTEXT_LIMIT in a session it started, in tokens.
M.DEFAULT = 200000
M.NUDGE = 0.75
M.STOP = 0.9

function M.limit()
  return tonumber(vim.g.corkboard_context_limit or os.getenv("CORKBOARD_CONTEXT_LIMIT") or "") or M.DEFAULT
end

-- The context of a session's last request: its input, cache writes and
-- cache reads, from the last main-thread assistant record in the
-- transcript. Only the file's end is read, so a long session costs no more.
local TAIL = 512 * 1024
function M.last(path)
  local fd = path and vim.uv.fs_open(vim.fn.expand(path), "r", 0)
  if not fd then return nil end
  local size = vim.uv.fs_fstat(fd).size
  local text = vim.uv.fs_read(fd, math.min(size, TAIL), math.max(0, size - TAIL)) or ""
  vim.uv.fs_close(fd)
  local lines = vim.split(text, "\n", { plain = true, trimempty = true })
  for i = #lines, 1, -1 do
    local line = lines[i]
    if line:find('"type":"assistant"', 1, true) and line:find('"usage"', 1, true) then
      local record = vim.F.npcall(vim.json.decode, line)
      local usage = record and not record.isSidechain and type(record.message) == "table" and record.message.usage
      if type(usage) == "table" then
        return (usage.input_tokens or 0) + (usage.cache_creation_input_tokens or 0) + (usage.cache_read_input_tokens or 0)
      end
    end
  end
end

return M
