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

-- A new page has none; a new colorscheme changes every colour.
function M.reset()
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

-- The columns the page draws over win's right edge (Scrollbars.tsx): the
-- minimap's, in a window wide enough for one, the scrollbar's in a narrower
-- one, none where it has neither (a terminal).
function M.covers(win)
  if sent[vim.api.nvim_win_get_buf(win)] == nil then return 0 end
  return vim.api.nvim_win_get_width(win) >= 60 and 12 or 1
end

return M
