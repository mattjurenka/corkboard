-- The text the page's minimap draws beside each window of text
-- (Scrollbars.tsx): corkboard.minimap, a buffer's lines as runs of
-- characters, each with its colour from treesitter's highlights, or the
-- syntax file's where the language has no parser. Sent when a
-- buffer comes into a window, and once typing in it pauses; { buf } alone
-- when it has left every window, so the page forgets it.
--
-- A run is three numbers, its first display column, its width and its
-- colour, an index into palette (0 is Normal's). Whitespace isn't a run.
--
-- Treesitter's captures take about 60ms a thousand lines, so the lines are
-- worked through SLICE at a time, a turn of the event loop each, and Neovim
-- keeps up with keys and redraws meanwhile.

local M = {}

local MAX_LINES = 10000
local MAX_COLS = 160
local SLICE = 100
local DEBOUNCE = 300 -- ms

-- By buffer: the changedtick sent (or being sent), the one its debounce
-- timer is waiting on, and the timer.
local sent, armed, timers = {}, {}, {}

local SKIP = { spell = true, nospell = true, conceal = true }

-- The highlights' colours as palette indexes, by capture and language.
local function colorer(palette)
  local index, hls = { [palette[1]] = 0 }, {}
  return function(name, lang)
    local key = name .. "." .. lang
    if hls[key] == nil then
      local hl = vim.api.nvim_get_hl(0, { name = "@" .. key, link = false })
      if not hl.fg then hl = vim.api.nvim_get_hl(0, { name = "@" .. name, link = false }) end
      local fg = hl.fg and string.format("#%06x", hl.fg)
      if fg and not index[fg] then
        table.insert(palette, fg)
        index[fg] = #palette - 1
      end
      hls[key] = fg and index[fg] or false
    end
    return hls[key]
  end
end

-- Each byte's palette index in lines first to last - 1 (0-based), by line.
local function captures(parser, buf, first, last, color)
  local colors = {}
  parser:for_each_tree(function(tree, ltree)
    local lang = ltree:lang()
    local query = vim.treesitter.query.get(lang, "highlights")
    if not query then return end
    for id, node in query:iter_captures(tree:root(), buf, first, last) do
      local name = query.captures[id]
      if name:sub(1, 1) ~= "_" and not SKIP[name] then
        local c = color(name, lang)
        if c then
          local sr, sc, er, ec = node:range()
          for row = math.max(sr, first), math.min(er, last - 1) do
            local line = colors[row] or {}
            colors[row] = line
            local from = row == sr and sc or 0
            local to = math.min(row == er and ec or math.huge, MAX_COLS * 4)
            for b = from + 1, to do line[b] = c end
          end
        end
      end
    end
  end)
  return colors
end

-- The same from the syntax file, for a buffer without a parser: the
-- colour at the start of each word, or run of punctuation, for all of it.
local function syntax_colors(buf, first, last)
  local colors, ids = {}, {}
  vim.api.nvim_buf_call(buf, function()
    for row = first, last - 1 do
      local text = vim.fn.getline(row + 1):sub(1, MAX_COLS * 4)
      local line, b, c = {}, 1, 0
      while b <= #text do
        local word = text:match("^[%w_]+", b) or text:match("^[^%w_%s]+", b) or text:match("^%s+", b)
        if not word:match("^%s") then
          local id = vim.fn.synIDtrans(vim.fn.synID(row + 1, b, 1))
          if ids[id] == nil then
            local fg = id ~= 0 and vim.api.nvim_get_hl(0, { name = vim.fn.synIDattr(id, "name"), link = false }).fg
            ids[id] = fg and string.format("#%06x", fg) or false
          end
          c = ids[id]
          for i = b, b + #word - 1 do line[i] = c end
        end
        b = b + #word
      end
      colors[row] = line
    end
  end)
  return colors
end

-- One line's runs: tabs to the next tabstop, a UTF-8 character one column.
local function runs(text, colors, ts, color)
  local out, col, start, width, run_color = {}, 0, nil, 0, nil
  local function flush()
    if start then vim.list_extend(out, { start, width, run_color }) end
    start = nil
  end
  for b = 1, #text do
    if col >= MAX_COLS then break end
    local byte = text:byte(b)
    if byte == 9 or byte == 32 then
      flush()
      col = byte == 9 and (math.floor(col / ts) + 1) * ts or col + 1
    elseif byte < 0x80 or byte >= 0xC0 then
      local c = colors and colors[b] or 0
      if type(c) ~= "number" then c = c and color(c) or 0 end
      if start and c ~= run_color then flush() end
      if not start then start, width, run_color = col, 0, c end
      width = width + 1
      col = col + 1
    end
  end
  flush()
  return out
end

local function send(buf)
  if not vim.api.nvim_buf_is_valid(buf) or sent[buf] == nil then return end
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  sent[buf] = tick
  local count = math.min(vim.api.nvim_buf_line_count(buf), MAX_LINES)
  local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
  local palette = { normal.fg and string.format("#%06x", normal.fg) or "" }
  local color = colorer(palette)
  local ok, parser = pcall(vim.treesitter.get_parser, buf, nil, { error = false })
  if not ok or not parser or not pcall(parser.parse, parser, true) then parser = nil end
  local syntax = not parser and vim.bo[buf].syntax ~= ""
  -- A syntax colour (#rrggbb) as its palette index.
  local index = {}
  local function syntax_color(fg)
    if fg == palette[1] then return 0 end
    if not index[fg] then
      table.insert(palette, fg)
      index[fg] = #palette - 1
    end
    return index[fg]
  end
  local ts = vim.bo[buf].tabstop
  local lines = {}
  local function slice(first)
    -- Gone, or a newer send has begun.
    if not vim.api.nvim_buf_is_valid(buf) or sent[buf] ~= tick then return end
    local last = math.min(first + SLICE, count)
    local colors = parser and captures(parser, buf, first, last, color)
      or syntax and syntax_colors(buf, first, last) or {}
    for i, text in ipairs(vim.api.nvim_buf_get_lines(buf, first, last, false)) do
      lines[first + i] = runs(text, colors[first + i - 1], ts, syntax_color)
    end
    if last < count then return vim.schedule(function() slice(last) end) end
    require("corkboard").notify("corkboard.minimap", { buf = buf, palette = palette, lines = lines })
  end
  slice(0)
end

-- From push_layout, with the buffers the scrollbars are for: each new one is
-- sent, each changed one once it stops changing (not in the redraw), and
-- each gone one dropped.
function M.check(bufs)
  local shown = {}
  for _, buf in ipairs(bufs) do
    shown[buf] = true
    local tick = vim.api.nvim_buf_get_changedtick(buf)
    if sent[buf] == nil then
      sent[buf], armed[buf] = -1, tick
      vim.schedule(function() send(buf) end)
    elseif sent[buf] ~= tick and armed[buf] ~= tick then
      -- Each change waits the pause again.
      armed[buf] = tick
      timers[buf] = timers[buf] or vim.uv.new_timer()
      timers[buf]:start(DEBOUNCE, 0, vim.schedule_wrap(function() send(buf) end))
    end
  end
  for buf in pairs(sent) do
    if not shown[buf] then
      sent[buf], armed[buf] = nil, nil
      if timers[buf] then timers[buf]:close() end
      timers[buf] = nil
      require("corkboard").notify("corkboard.minimap", { buf = buf })
    end
  end
end

-- A new page has none, and its columns are checked; a new colorscheme
-- changes every colour.
function M.reset()
  vim.schedule(M.sync)
  for buf in pairs(sent) do sent[buf], armed[buf] = nil, nil end
end

vim.api.nvim_create_autocmd("ColorScheme", {
  group = vim.api.nvim_create_augroup("corkboard.minimap", {}),
  callback = function()
    for buf in pairs(sent) do
      sent[buf] = -1
      vim.schedule(function() send(buf) end)
    end
  end,
})

-- The minimap's column: a split of its own to the right of each window of
-- text at least MIN wide (with it), so the text wraps short of it rather
-- than running under it. Empty; the page draws the minimap over it. It
-- goes with its window, and the keys pass it by: entered from its window
-- they go on past it, from anywhere else, back to its window.
local COLS = 12
local MIN = 60

local function valid_win(win) return win and vim.api.nvim_win_is_valid(win) end

local function is_column(win) return vim.w[win].corkboard_minimap_of ~= nil end

-- A split showing text, as the scrollbars have: not a terminal or a panel.
function M.text_win(win)
  local buf = vim.api.nvim_win_get_buf(win)
  return vim.api.nvim_win_get_config(win).relative == "" and not vim.b[buf].corkboard_view
    and vim.bo[buf].buftype ~= "terminal" and not is_column(win)
end

-- win's minimap column, if it has one.
function M.column(win)
  local col = vim.w[win].corkboard_minimap
  if valid_win(col) and vim.w[col].corkboard_minimap_of == win then return col end
end

local column_buf
local function blank()
  if column_buf and vim.api.nvim_buf_is_valid(column_buf) then return column_buf end
  column_buf = vim.api.nvim_create_buf(false, true)
  vim.bo[column_buf].bufhidden = "hide"
  vim.bo[column_buf].modifiable = false
  return column_buf
end

local function close(col)
  if not pcall(vim.api.nvim_win_close, col, true) then
    -- The last window there is: it becomes an ordinary one.
    vim.w[col].corkboard_minimap_of = nil
    vim.api.nvim_win_set_buf(col, vim.api.nvim_create_buf(true, false))
    vim.api.nvim_win_set_config(col, { focusable = true })
  end
end

-- Straight to win's right, as tall as it: a split made to its right later
-- (a markdown preview) comes between them, and the column moves back.
local function beside(win, col)
  local a, b = vim.fn.getwininfo(win)[1], vim.fn.getwininfo(col)[1]
  return b.winrow == a.winrow and b.height == a.height and b.wincol == a.wincol + a.width + 1
end

function M.sync()
  -- Only for a page, which draws in it.
  local wide = require("corkboard").attached() and not require("corkboard").narrow()
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if valid_win(win) and is_column(win) then
      local of = vim.w[win].corkboard_minimap_of
      if not (valid_win(of) and M.text_win(of) and vim.w[of].corkboard_minimap == win and wide) then close(win) end
    end
  end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if valid_win(win) and M.text_win(win) then
      local col = M.column(win)
      if col and not beside(win, col) then
        close(col)
        col = nil
      end
      local width = vim.api.nvim_win_get_width(win) + (col and COLS + 1 or 0)
      if col and width < MIN then
        close(col)
      elseif not col and wide and width >= MIN then
        col = vim.api.nvim_open_win(blank(), false, { split = "right", win = win, width = COLS, focusable = false, noautocmd = true })
        vim.w[win].corkboard_minimap = col
        vim.w[col].corkboard_minimap_of = win
        for k, v in pairs({ winfixwidth = true, number = false, relativenumber = false, signcolumn = "no",
          foldcolumn = "0", cursorline = false, list = false, statusline = " ", winbar = "" }) do
          vim.wo[col][k] = v
        end
        vim.wo[col].fillchars = "eob: "
      end
    end
  end
end

-- Once a turn: each change of window can be several events.
local pending = false
local function schedule()
  if pending then return end
  pending = true
  vim.schedule(function()
    pending = false
    M.sync()
  end)
end

local group = vim.api.nvim_create_augroup("corkboard.minimap.column", {})
vim.api.nvim_create_autocmd({ "WinNew", "WinClosed", "WinResized", "VimResized", "BufWinEnter", "TabEnter" }, {
  group = group,
  callback = schedule,
})
vim.api.nvim_create_autocmd("User", { group = group, pattern = "CorkboardNarrow", callback = schedule })
vim.api.nvim_create_autocmd("WinEnter", {
  group = group,
  callback = function()
    local col = vim.api.nvim_get_current_win()
    local of = vim.w[col].corkboard_minimap_of
    if not valid_win(of) then return end
    local from = vim.fn.win_getid(vim.fn.winnr("#"))
    vim.schedule(function()
      if vim.api.nvim_get_current_win() ~= col then return end
      if from == of then vim.cmd("wincmd l") end
      if vim.api.nvim_get_current_win() == col then vim.api.nvim_set_current_win(of) end
    end)
  end,
})
-- :q in the tab's last window of text quits it, or the tab, columns and all.
vim.api.nvim_create_autocmd("QuitPre", {
  group = group,
  callback = function()
    local cur = vim.api.nvim_get_current_win()
    local cols = {}
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if is_column(win) then
        table.insert(cols, win)
      elseif win ~= cur and vim.api.nvim_win_get_config(win).relative == "" then
        return
      end
    end
    for _, col in ipairs(cols) do pcall(vim.api.nvim_win_close, col, true) end
  end,
})
schedule()

-- The columns the page draws over win's right edge (Scrollbars.tsx): the
-- scrollbar's, in a window of text without a minimap column, none where it
-- has one or neither (a terminal).
function M.covers(win)
  if sent[vim.api.nvim_win_get_buf(win)] == nil or M.column(win) then return 0 end
  return 1
end

return M
