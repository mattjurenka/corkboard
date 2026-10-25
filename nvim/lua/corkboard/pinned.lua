-- What the board, usage and day plan views share: each lives in a tab of its
-- own at a fixed position (in a project's window the board first and usage
-- second; in the day plan's window the plan), and each is a listing whose
-- cursor line selects an item.
--
-- Neovim can't refuse a :tabclose, so ensure() runs after anything that could
-- have closed or moved a pinned tab, and puts it back.

local M = {}

local function find_tab(key)
  for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
    if vim.t[tab][key] then return tab end
  end
end

local function find_win(tab, buf)
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    if vim.api.nvim_win_get_buf(win) == buf then return win end
  end
end

-- The unnamed, unmodified, empty window Neovim starts with (or :tabnew makes).
local function empty_window(tab)
  local wins = vim.tbl_filter(function(w)
    return vim.api.nvim_win_get_config(w).relative == ""
  end, vim.api.nvim_tabpage_list_wins(tab))
  if #wins ~= 1 then return nil end
  local b = vim.api.nvim_win_get_buf(wins[1])
  local empty = vim.api.nvim_buf_get_name(b) == "" and not vim.bo[b].modified
    and vim.api.nvim_buf_line_count(b) == 1 and vim.api.nvim_buf_get_lines(b, 0, 1, false)[1] == ""
  return empty and wins[1] or nil
end

local busy = false

-- Keep buf in the tab marked t:<key>, at tab position index. Leaves focus
-- where it was. Returns whether anything had to be made.
function M.ensure(key, index, buf)
  if busy or vim.v.exiting ~= vim.NIL then return false end
  busy = true
  local ok, created = pcall(function()
    local from = vim.api.nvim_get_current_win()
    local created = false

    local tab = find_tab(key)
    if not tab then
      local tabs = vim.api.nvim_list_tabpages()
      if #tabs == 1 and empty_window(tabs[1]) then
        tab = tabs[1]
      else
        vim.cmd((index - 1) .. "tabnew")
        tab = vim.api.nvim_get_current_tabpage()
      end
      vim.t[tab][key] = true
      created = true
    end

    if vim.api.nvim_tabpage_get_number(tab) ~= index then
      vim.api.nvim_set_current_tabpage(tab)
      vim.cmd("tabmove " .. (index - 1))
    end

    if not find_win(tab, buf) then
      vim.api.nvim_set_current_tabpage(tab)
      local win = empty_window(tab)
      if not win then
        vim.cmd("topleft vsplit")
        win = vim.api.nvim_get_current_win()
      end
      local empty = vim.api.nvim_win_get_buf(win)
      vim.api.nvim_win_set_buf(win, buf)
      if empty ~= buf and vim.api.nvim_buf_get_name(empty) == "" then pcall(vim.api.nvim_buf_delete, empty, {}) end
      created = true
    end

    if vim.api.nvim_win_is_valid(from) then vim.api.nvim_set_current_win(from) end
    return created
  end)
  busy = false
  if not ok then
    vim.notify("corkboard: " .. tostring(created), vim.log.levels.ERROR)
    return false
  end
  return created
end

-- Go to buf's pinned tab and window.
function M.show(key, index, buf)
  M.ensure(key, index, buf)
  local tab = find_tab(key)
  vim.api.nvim_set_current_tabpage(tab)
  vim.api.nvim_set_current_win(find_win(tab, buf))
end

-- Listings --------------------------------------------------------------------
--
-- lines maps line numbers to item ids; the rest of the lines are headers.

function M.line_of(lines, id)
  for lnum, item in pairs(lines) do
    if item == id then return lnum end
  end
end

-- Move to the next (dir 1) or previous (dir -1) item line.
function M.step(lines, dir)
  local here = vim.api.nvim_win_get_cursor(0)[1]
  local lnums = vim.tbl_keys(lines)
  table.sort(lnums)
  for i = dir > 0 and 1 or #lnums, dir > 0 and #lnums or 1, dir do
    if (dir > 0 and lnums[i] > here) or (dir < 0 and lnums[i] < here) then
      return vim.api.nvim_win_set_cursor(0, { lnums[i], 2 })
    end
  end
end

-- Put the cursor of every window showing buf on item id.
function M.follow(buf, lines, id)
  local lnum = id and M.line_of(lines, id)
  if not lnum then return end
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    if vim.api.nvim_win_get_cursor(win)[1] ~= lnum then vim.api.nvim_win_set_cursor(win, { lnum, 2 }) end
  end
end

-- A read-only listing buffer named name, shown as an HTML view. keys maps
-- lhs to { fn, desc }; on_select(id) runs when the cursor moves onto another
-- item.
function M.listing(name, view, keys, current, on_select)
  local b = vim.api.nvim_create_buf(true, true)
  vim.api.nvim_buf_set_name(b, name)
  vim.bo[b].filetype = "corkboard"
  vim.bo[b].modifiable = false
  vim.b[b].corkboard_view = view
  for lhs, key in pairs(keys) do
    vim.keymap.set("n", lhs, key[1], { buffer = b, nowait = true, desc = view .. ": " .. key[2] })
  end
  vim.api.nvim_create_autocmd("CursorMoved", {
    buffer = b,
    callback = function()
      local id = current()[vim.api.nvim_win_get_cursor(0)[1]]
      if id then on_select(id) end
    end,
  })
  return b
end

-- Replace a listing's text.
function M.set_lines(buf, lines)
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
end

return M
