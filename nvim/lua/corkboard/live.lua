-- What this Neovim knows that its Claude Code sessions draw (the mod in
-- claude-plugin/): where this Neovim is, and today's plan. One JSON file
-- per Neovim, its path in each session's CORKBOARD_LIVE; the mod reads it
-- again when it changes. Removed when Neovim exits.

local M = {}

local parts = {}
local written

function M.path()
  return vim.fs.joinpath(vim.fn.stdpath("state"), "corkboard", "live", vim.fn.getpid() .. ".json")
end

-- Set one part of the file (cards, plan) and write it if that changed it.
function M.set(key, value)
  parts[key] = value
  local text = vim.json.encode(parts)
  if text == written then return end
  written = text
  local path = M.path()
  vim.fn.mkdir(vim.fs.dirname(path), "p", tonumber("700", 8))
  -- Renamed into place, so the mod never reads half a file.
  local tmp = path .. ".tmp"
  local fd = vim.uv.fs_open(tmp, "w", tonumber("600", 8))
  if not fd then return end
  vim.uv.fs_write(fd, text)
  vim.uv.fs_close(fd)
  vim.uv.fs_rename(tmp, path)
end

vim.api.nvim_create_autocmd("VimLeavePre", {
  group = vim.api.nvim_create_augroup("corkboard.live", {}),
  callback = function()
    if written then vim.uv.fs_unlink(M.path()) end
  end,
})

return M
