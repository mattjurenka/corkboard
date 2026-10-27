-- Focus mode (<leader>z, :AgentFocus): the window being edited, alone. A
-- window that shares its tab gets a tab of its own (:tab split, the same
-- buffer), and the page hides the sidebar and narrows the grid to a column
-- of text in the middle (corkboard.focus, App.tsx). Toggling again closes
-- that tab and goes back to the window it came from, at the cursor it left.
--
-- vim.g.corkboard_focus_width: the column's text width; textwidth, else 100.

local M = {}

-- { tab, win, from } while on: the focus tab, if one was made, and its
-- window; the window it came from. nil when off.
local state

local function width()
  local win = state and state.win or vim.api.nvim_get_current_win()
  local tw = vim.bo[vim.api.nvim_win_get_buf(win)].textwidth
  tw = vim.g.corkboard_focus_width or (tw > 0 and tw) or 100
  local info = vim.fn.getwininfo(win)[1]
  return tw + (info and info.textoff or 0)
end

-- What the page needs: whether it's on, and how many columns wide.
function M.push()
  require("corkboard").notify("corkboard.focus", state and { width = width() } or vim.NIL)
end

function M.on() return state ~= nil end

local function splits()
  return vim.tbl_filter(function(w)
    return vim.api.nvim_win_get_config(w).relative == ""
  end, vim.api.nvim_tabpage_list_wins(0))
end

function M.enter()
  if state then return end
  local from = vim.api.nvim_get_current_win()
  if vim.api.nvim_win_get_config(from).relative ~= "" then
    return vim.notify("corkboard: focus a window, not a float")
  end
  if require("corkboard").is_panel(vim.api.nvim_get_current_buf()) then
    return vim.notify("corkboard: focus mode is for text and terminals")
  end
  state = { from = from }
  if #splits() > 1 then
    vim.cmd("tab split")
    state.tab = vim.api.nvim_get_current_tabpage()
    vim.t.corkboard_focus = true
  end
  state.win = vim.api.nvim_get_current_win()
  M.push()
end

function M.leave()
  if not state then return end
  local s = state
  state = nil
  if s.tab then
    -- Read before the tab closes and takes the window with it.
    local here = vim.api.nvim_win_is_valid(s.win)
      and { buf = vim.api.nvim_win_get_buf(s.win), cursor = vim.api.nvim_win_get_cursor(s.win) }
    if vim.api.nvim_tabpage_is_valid(s.tab) then vim.cmd.tabclose(vim.api.nvim_tabpage_get_number(s.tab)) end
    if vim.api.nvim_win_is_valid(s.from) then
      vim.api.nvim_set_current_win(s.from)
      if here and vim.api.nvim_win_get_buf(s.from) == here.buf then
        pcall(vim.api.nvim_win_set_cursor, s.from, here.cursor)
      end
    end
  end
  M.push()
end

function M.toggle()
  if state then M.leave() else M.enter() end
end

function M.setup()
  vim.keymap.set("n", "<leader>z", M.toggle, { desc = "corkboard: focus mode" })
  vim.api.nvim_create_user_command("AgentFocus", M.toggle, { desc = "corkboard: focus mode" })
  local group = vim.api.nvim_create_augroup("corkboard.focus", {})
  -- Closing the focus tab (<A-q>, :q) or the window it's about ends it.
  vim.api.nvim_create_autocmd({ "TabClosed", "WinClosed" }, {
    group = group,
    callback = function()
      vim.schedule(function()
        if not state then return end
        local gone = state.tab and not vim.api.nvim_tabpage_is_valid(state.tab)
          or not state.tab and not vim.api.nvim_win_is_valid(state.win)
        if gone then M.leave() end
      end)
    end,
  })
  -- A new file or buffer in the window can want a different width.
  vim.api.nvim_create_autocmd({ "BufWinEnter", "OptionSet" }, {
    group = group,
    callback = function()
      if state then vim.schedule(M.push) end
    end,
  })
end

return M
