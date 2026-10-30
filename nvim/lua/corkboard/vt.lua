-- The colors a Claude terminal shows, for the phone (corkboard.away's
-- screen). Neovim keeps a terminal's colors to itself, so each one's output
-- goes through this too: a small emulator of what Claude Code draws (cursor
-- moves, erases, scrolling, SGR), kept at its window's size. Neovim's buffer
-- stays the truth for the text; a line takes its colors from here only
-- where the two agree on it.

local M = {}

local SCROLLBACK = 1000

-- An attribute: fg and bg (-1 the default, 0-255 the palette, 2^24 + rgb a
-- color of its own) and flags (bold 1, dim 2, italic 4, underline 8,
-- reverse 16, strike 32). Interned, so a cell holds one number.
local attrs, index = { { -1, -1, 0 } }, { ["-1,-1,0"] = 1 }

local function intern(fg, bg, flags)
  local k = fg .. "," .. bg .. "," .. flags
  local i = index[k]
  if not i then
    table.insert(attrs, { fg, bg, flags })
    i = #attrs
    index[k] = i
  end
  return i
end

local function blank(cols, attr)
  local line = {}
  for c = 1, cols do
    line[c] = { " ", attr or 1 }
  end
  return line
end

local function new(rows, cols)
  local s = { rows = rows, cols = cols, back = {}, r = 1, c = 1, fg = -1, bg = -1, flags = 0, top = 1, bottom = rows, rest = "" }
  s.grid = {}
  for r = 1, rows do
    s.grid[r] = blank(cols)
  end
  return s
end

local function attr(s)
  return intern(s.fg, s.bg, s.flags)
end

-- The cells a character takes; 0 for one that joins the last.
local widths = {}
local function width(cp, ch)
  if cp < 0x300 then return 1 end
  if (cp >= 0x300 and cp <= 0x36f) or cp == 0x200d or (cp >= 0xfe00 and cp <= 0xfe0f) then return 0 end
  if cp < 0x1100 then return 1 end
  local w = widths[cp]
  if not w then
    w = vim.fn.strwidth(ch)
    widths[cp] = w
  end
  return w
end

-- The characters in a string of UTF-8: its bytes but for continuations.
local function chars(str)
  local _, cont = str:gsub("[\128-\191]", "")
  return #str - cont
end

local function resize(s, rows, cols)
  if rows == s.rows and cols == s.cols then return end
  for r = 1, rows do
    local line = s.grid[r] or blank(cols)
    for c = #line + 1, cols do
      line[c] = { " ", 1 }
    end
    for c = #line, cols + 1, -1 do
      line[c] = nil
    end
    s.grid[r] = line
  end
  for r = #s.grid, rows + 1, -1 do
    s.grid[r] = nil
  end
  s.rows, s.cols = rows, cols
  s.top, s.bottom = 1, rows
  s.r, s.c = math.min(s.r, rows), math.min(s.c, cols)
end

local function scroll_up(s, n, inside)
  for _ = 1, n do
    local gone = table.remove(s.grid, s.top)
    if s.top == 1 and not s.alt and not inside then
      table.insert(s.back, gone)
      if #s.back > SCROLLBACK then table.remove(s.back, 1) end
    end
    table.insert(s.grid, s.bottom, blank(s.cols, attr(s)))
  end
end

local function scroll_down(s, n)
  for _ = 1, n do
    table.remove(s.grid, s.bottom)
    table.insert(s.grid, s.top, blank(s.cols, attr(s)))
  end
end

local function linefeed(s)
  if s.r == s.bottom then
    scroll_up(s, 1)
  elseif s.r < s.rows then
    s.r = s.r + 1
  end
end

local function put(s, ch, cp)
  local w = width(cp, ch)
  if w == 0 then
    local prev = s.grid[s.r][math.max(1, s.c - 1)]
    prev[1] = prev[1] .. ch
    return
  end
  if s.wrap then
    s.wrap = false
    s.c = 1
    linefeed(s)
  end
  if s.c + w - 1 > s.cols then
    s.c = 1
    linefeed(s)
  end
  local line, a = s.grid[s.r], attr(s)
  line[s.c] = { ch, a }
  -- The second cell of a wide one has nothing of its own.
  if w == 2 and s.c < s.cols then line[s.c + 1] = { "", a } end
  if s.c + w > s.cols then
    s.wrap = true
  else
    s.c = s.c + w
  end
end

local function erase(line, from, to, a)
  for c = math.max(1, from), math.min(#line, to) do
    line[c] = { " ", a }
  end
end

local function color(p, i)
  local mode = p[i + 1]
  if mode == 5 then return p[i + 2] or -1, i + 2 end
  if mode == 2 then return 2 ^ 24 + (p[i + 2] or 0) * 65536 + (p[i + 3] or 0) * 256 + (p[i + 4] or 0), i + 4 end
  return -1, i
end

local FLAG = { [1] = 1, [2] = 2, [3] = 4, [4] = 8, [7] = 16, [9] = 32 }
local UNFLAG = { [22] = 3, [23] = 4, [24] = 8, [27] = 16, [29] = 32 }

local function sgr(s, p)
  if #p == 0 then p = { 0 } end
  local i = 1
  while i <= #p do
    local n = p[i] or 0
    if n == 0 then
      s.fg, s.bg, s.flags = -1, -1, 0
    elseif FLAG[n] then
      s.flags = bit.bor(s.flags, FLAG[n])
    elseif UNFLAG[n] then
      s.flags = bit.band(s.flags, bit.bnot(UNFLAG[n]))
    elseif n >= 30 and n <= 37 then
      s.fg = n - 30
    elseif n == 38 then
      s.fg, i = color(p, i)
    elseif n == 39 then
      s.fg = -1
    elseif n >= 40 and n <= 47 then
      s.bg = n - 40
    elseif n == 48 then
      s.bg, i = color(p, i)
    elseif n == 49 then
      s.bg = -1
    elseif n >= 90 and n <= 97 then
      s.fg = n - 90 + 8
    elseif n >= 100 and n <= 107 then
      s.bg = n - 100 + 8
    end
    i = i + 1
  end
end

local function alt_screen(s, on)
  if on == not not s.alt then return end
  if on then
    s.alt = { grid = s.grid, r = s.r, c = s.c }
    s.grid = {}
    for r = 1, s.rows do
      s.grid[r] = blank(s.cols)
    end
  else
    s.grid, s.r, s.c = s.alt.grid, s.alt.r, s.alt.c
    s.alt = nil
    resize(s, s.rows, s.cols)
  end
end

local function csi(s, private, raw, final)
  local p = {}
  -- 38:2::r:g:b as well as 38;2;r;g;b.
  for part in (raw .. ";"):gmatch("([^;]*);") do
    local sub = vim.split(part, ":", { plain = true })
    if #sub > 1 then
      table.insert(p, tonumber(sub[1]))
      table.insert(p, tonumber(sub[2]))
      for k = (#sub >= 6 and 4 or 3), #sub do
        table.insert(p, tonumber(sub[k]) or 0)
      end
    else
      table.insert(p, tonumber(part))
    end
  end
  if raw == "" then p = {} end
  local n = math.max(1, p[1] or 1)
  local line = s.grid[s.r]
  if private == "?" then
    if (final == "h" or final == "l") then
      for _, m in ipairs(p) do
        if m == 1049 or m == 1047 or m == 47 then alt_screen(s, final == "h") end
      end
    end
    return
  end
  if private ~= "" then return end
  s.wrap = false
  if final == "m" then
    sgr(s, p)
  elseif final == "A" then
    s.r = math.max(s.r <= s.bottom and s.r >= s.top and s.top or 1, s.r - n)
  elseif final == "B" or final == "e" then
    s.r = math.min(s.r <= s.bottom and s.r >= s.top and s.bottom or s.rows, s.r + n)
  elseif final == "C" or final == "a" then
    s.c = math.min(s.cols, s.c + n)
  elseif final == "D" then
    s.c = math.max(1, s.c - n)
  elseif final == "E" then
    s.r, s.c = math.min(s.rows, s.r + n), 1
  elseif final == "F" then
    s.r, s.c = math.max(1, s.r - n), 1
  elseif final == "G" or final == "`" then
    s.c = math.min(s.cols, n)
  elseif final == "d" then
    s.r = math.min(s.rows, n)
  elseif final == "H" or final == "f" then
    s.r, s.c = math.min(s.rows, math.max(1, p[1] or 1)), math.min(s.cols, math.max(1, p[2] or 1))
  elseif final == "J" then
    local mode, a = p[1] or 0, attr(s)
    if mode == 0 then
      erase(line, s.c, s.cols, a)
      for r = s.r + 1, s.rows do
        s.grid[r] = blank(s.cols, a)
      end
    elseif mode == 1 then
      erase(line, 1, s.c, a)
      for r = 1, s.r - 1 do
        s.grid[r] = blank(s.cols, a)
      end
    elseif mode == 2 or mode == 3 then
      for r = 1, s.rows do
        s.grid[r] = blank(s.cols, a)
      end
      if mode == 3 then s.back = {} end
    end
  elseif final == "K" then
    local mode, a = p[1] or 0, attr(s)
    if mode == 0 then
      erase(line, s.c, s.cols, a)
    elseif mode == 1 then
      erase(line, 1, s.c, a)
    else
      erase(line, 1, s.cols, a)
    end
  elseif final == "X" then
    erase(line, s.c, s.c + n - 1, attr(s))
  elseif final == "P" then
    for _ = 1, math.min(n, s.cols - s.c + 1) do
      table.remove(line, s.c)
      table.insert(line, { " ", attr(s) })
    end
  elseif final == "@" then
    for _ = 1, math.min(n, s.cols - s.c + 1) do
      table.insert(line, s.c, { " ", attr(s) })
      table.remove(line)
    end
  elseif final == "L" or final == "M" then
    if s.r >= s.top and s.r <= s.bottom then
      local top = s.top
      s.top = s.r
      -- Lines deleted inside the screen never reach the scrollback.
      if final == "L" then scroll_down(s, n) else scroll_up(s, n, true) end
      s.top = top
    end
  elseif final == "S" then
    scroll_up(s, n)
  elseif final == "T" then
    scroll_down(s, n)
  elseif final == "r" then
    s.top, s.bottom = math.max(1, p[1] or 1), math.min(s.rows, p[2] or s.rows)
    if s.top >= s.bottom then s.top, s.bottom = 1, s.rows end
    s.r, s.c = 1, 1
  elseif final == "s" then
    s.saved = { s.r, s.c }
  elseif final == "u" then
    if s.saved then s.r, s.c = s.saved[1], s.saved[2] end
  end
end

-- Output, as it comes; what's cut off mid-sequence waits for the rest.
local function feed(s, data)
  data = s.rest .. data
  s.rest = ""
  local i, len = 1, #data
  while i <= len do
    local b = data:byte(i)
    if b == 27 then
      local nxt = data:sub(i + 1, i + 1)
      if nxt == "" then
        s.rest = data:sub(i)
        return
      elseif nxt == "[" then
        local private, raw, final, j = data:match("^([<=>?]?)([%d;:]*)[ -/]*([@-~])()", i + 2)
        if not j then
          if len - i > 64 then i = i + 2 else s.rest = data:sub(i) return end
        else
          csi(s, private, raw, final)
          i = j
        end
      elseif nxt == "]" or nxt == "P" or nxt == "_" or nxt == "^" or nxt == "X" then
        -- A string to its BEL or ST, said nothing of here.
        local bel, st = data:find("\7", i + 2, true), data:find("\27\\", i + 2, true)
        local j = bel and (not st or bel < st) and bel or st and st + 1
        if not j then
          s.rest = data:sub(i)
          return
        end
        i = j + 1
      elseif nxt == "7" then
        s.saved = { s.r, s.c }
        i = i + 2
      elseif nxt == "8" then
        if s.saved then s.r, s.c = s.saved[1], s.saved[2] end
        i = i + 2
      elseif nxt == "D" then
        linefeed(s)
        i = i + 2
      elseif nxt == "E" then
        linefeed(s)
        s.c = 1
        i = i + 2
      elseif nxt == "M" then
        if s.r == s.top then scroll_down(s, 1) else s.r = math.max(1, s.r - 1) end
        i = i + 2
      elseif nxt == "c" then
        local rows, cols = s.rows, s.cols
        for k, v in pairs(new(rows, cols)) do
          s[k] = v
        end
        i = i + 2
      elseif nxt:match("[%(%)%*%+#%%]") then
        i = i + 3
      else
        i = i + 2
      end
    elseif b == 13 then
      s.c, s.wrap = 1, false
      i = i + 1
    elseif b == 10 or b == 11 or b == 12 then
      s.wrap = false
      linefeed(s)
      i = i + 1
    elseif b == 8 then
      s.c, s.wrap = math.max(1, s.c - 1), false
      i = i + 1
    elseif b == 9 then
      s.c = math.min(s.cols, (math.floor((s.c - 1) / 8) + 1) * 8 + 1)
      i = i + 1
    elseif b < 32 or b == 127 then
      i = i + 1
    else
      local n = b < 0x80 and 1 or b >= 0xf0 and 4 or b >= 0xe0 and 3 or b >= 0xc0 and 2 or 1
      if i + n - 1 > len then
        s.rest = data:sub(i)
        return
      end
      local ch = data:sub(i, i + n - 1)
      local cp = b
      if n > 1 then
        cp = bit.band(b, n == 2 and 0x1f or n == 3 and 0x0f or 0x07)
        for k = 2, n do
          cp = bit.bor(bit.lshift(cp, 6), bit.band(data:byte(i + k - 1), 0x3f))
        end
      end
      put(s, ch, cp)
      i = i + n
    end
  end
end

local terms = {}

-- The size of the window it's in; nil when it's in none.
local function size(buf)
  local win = vim.fn.win_findbuf(buf)[1]
  if not win then return end
  local info = vim.fn.getwininfo(win)[1]
  return vim.api.nvim_win_get_height(win), vim.api.nvim_win_get_width(win) - info.textoff
end

-- jobstart's on_stdout for buf's terminal.
function M.track(buf)
  return function(_, data)
    local s = terms[buf]
    local rows, cols = size(buf)
    if not s then
      s = new(rows or 24, cols or 80)
      terms[buf] = s
    elseif rows then
      resize(s, rows, cols)
    end
    feed(s, table.concat(data, "\n"))
  end
end

function M.forget(buf)
  terms[buf] = nil
end

local function text(line)
  local out = {}
  for c = 1, #line do
    out[c] = line[c][1]
  end
  return (table.concat(out):gsub("%s+$", ""))
end

-- A line's colors as runs, each { characters, fg, bg, flags }, counting
-- the characters of its text.
local function runs(line, count)
  local out, last = {}, nil
  local seen = 0
  for c = 1, #line do
    local cell = line[c]
    if seen >= count then break end
    if cell[1] ~= "" then
      local n = math.min(chars(cell[1]), count - seen)
      seen = seen + n
      if last and last.attr == cell[2] then
        last[1] = last[1] + n
      else
        local a = attrs[cell[2]]
        last = { n, a[1], a[2], a[3], attr = cell[2] }
        table.insert(out, last)
      end
    end
  end
  for _, r in ipairs(out) do
    r.attr = nil
  end
  -- A line all in the default says nothing.
  if #out == 1 and out[1][2] == -1 and out[1][3] == -1 and out[1][4] == 0 then return {} end
  return out
end

-- Colors for lines of buf's buffer, from its line first on, of total: by
-- line, its runs, or an empty list where this doesn't know it. nil for a
-- terminal it never saw.
function M.colors(buf, lines, first, total)
  local s = terms[buf]
  if not s then return nil end
  local mine = vim.list_extend(vim.list_slice(s.back), s.grid)
  -- Both end at the screen's last row.
  local shift = #mine - total
  local out = {}
  for k, l in ipairs(lines) do
    local line = mine[first + k - 1 + shift]
    out[k] = (line and text(line) == l) and runs(line, chars(l)) or {}
  end
  return out
end

-- The 16 colors Neovim's terminals use, where it says.
function M.palette()
  local out = {}
  for n = 0, 15 do
    local c = vim.g["terminal_color_" .. n]
    if not c then return nil end
    out[n + 1] = c
  end
  return out
end

M._new, M._feed, M._text = new, feed, text

return M
