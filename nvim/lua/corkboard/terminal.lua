-- Shells: the toggled one along the bottom of a tab, and shells in tabs of
-- their own.

local M = {}

-- Whether a terminal buffer's job is still running.
function M.alive(buf)
  return buf ~= nil and vim.api.nvim_buf_is_valid(buf) and vim.fn.jobwait({ vim.bo[buf].channel }, 0)[1] == -1
end

-- A new tab showing buf, with :tabnew's empty buffer cleaned up.
local function tab_with(buf)
  vim.cmd.tabnew()
  local empty = vim.api.nvim_get_current_buf()
  vim.api.nvim_win_set_buf(0, buf)
  if empty ~= buf then pcall(vim.api.nvim_buf_delete, empty, {}) end
end

-- A shell in a tab of its own.
function M.tab()
  vim.cmd.tabnew()
  local empty = vim.api.nvim_get_current_buf()
  vim.cmd.terminal()
  if empty ~= vim.api.nvim_get_current_buf() then pcall(vim.api.nvim_buf_delete, empty, {}) end
  vim.t.corkboard_terminal_tab = true
end

-- <C-`>: a shell along the bottom of the tab. Toggles: hidden when shown,
-- back (the same shell) when not. One per tab, made again once it exits.
-- Not in a shell's own tab.
function M.toggle()
  if vim.t.corkboard_terminal_tab then return end
  local buf = vim.t.corkboard_terminal
  local alive = M.alive(buf)
  for _, win in ipairs(buf and vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_tabpage_list_wins(0) or {}) do
    if vim.api.nvim_win_get_buf(win) == buf then
      -- The last window of a tab can't be hidden.
      if #vim.api.nvim_tabpage_list_wins(0) == 1 then return end
      vim.api.nvim_win_hide(win)
      if not alive then pcall(vim.api.nvim_buf_delete, buf, { force = true }) end
      return
    end
  end
  if alive then
    vim.cmd("botright 15split")
    vim.api.nvim_win_set_buf(0, buf)
  else
    vim.cmd("botright 15split | terminal")
    vim.bo.bufhidden = "hide"
    vim.t.corkboard_terminal = vim.api.nvim_get_current_buf()
  end
end

-- Go to a terminal: the window showing it, or a new tab if it is hidden.
-- False when the buffer is gone.
function M.focus(buf)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return false end
  local win = vim.fn.win_findbuf(buf)[1]
  if win then
    vim.api.nvim_set_current_win(win)
  else
    tab_with(buf)
  end
  return true
end

return M
