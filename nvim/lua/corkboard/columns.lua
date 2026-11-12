-- Two columns in a float: a choice on the left, and on the right what that
-- choice offers, which follows the left's cursor. j/k move in a column;
-- l, <Tab> or <CR> go right, h or <S-Tab> back; <CR> on the right runs it.
-- A click on the left chooses there and goes right; on the right, runs it.

local M = {}

local ns = vim.api.nvim_create_namespace("corkboard.columns")

local function width(s) return vim.fn.strdisplaywidth(s) end

-- s in exactly w cells: cut with … when it's longer, padded when shorter.
local function fit(s, w)
  if width(s) > w then
    local out = ""
    for _, ch in ipairs(vim.fn.split(s, "\\zs")) do
      if width(out .. ch) > w - 1 then break end
      out = out .. ch
    end
    s = out .. "…"
  end
  return s .. string.rep(" ", w - width(s))
end

-- The last choice in each keyed pick, { left, right } texts, kept across
-- restarts so the next open starts on it.
local function last_path() return vim.fs.joinpath(vim.fn.stdpath("state"), "corkboard", "columns.json") end

local function read_last()
  local f = io.open(last_path(), "r")
  if not f then return {} end
  local ok, got = pcall(vim.json.decode, f:read("*a"))
  f:close()
  return ok and type(got) == "table" and got or {}
end

local function save_last(key, l, r)
  local all = read_last()
  all[key] = { left = l, right = r }
  vim.fn.mkdir(vim.fs.dirname(last_path()), "p")
  local f = io.open(last_path(), "w")
  if not f then return end
  f:write(vim.json.encode(all))
  f:close()
end

-- opts: title; left, a list of { text }; right(item), a list of
-- { text, detail?, run } for a left item; start, the left's first row;
-- key, to open on the last choice made in a pick with the same key.
function M.pick(opts)
  local left = opts.left
  if #left == 0 then return end
  local rights = {}
  for i, it in ipairs(left) do rights[i] = opts.right(it) or {} end

  local lw, rw, rows = 0, 0, #left
  for i, it in ipairs(left) do
    lw = math.max(lw, width(it.text))
    for _, r in ipairs(rights[i]) do rw = math.max(rw, width(r.text) + (r.detail and (2 + width(r.detail)) or 0)) end
    rows = math.max(rows, #rights[i])
  end
  rw = math.max(math.min(rw, vim.o.columns - lw - 9), 12)
  local height = math.max(math.min(rows, vim.o.lines - 6), 1)

  local li, ri, side = math.min(opts.start or 1, #left), 1, "left"
  local ltop, rtop = 1, 1
  local last = opts.key and read_last()[opts.key]
  for i, it in ipairs(last and left or {}) do
    if it.text == last.left then
      li = i
      for j, r in ipairs(rights[i]) do
        if r.text == last.right then ri, side = j, "right" end
      end
    end
  end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "wipe"
  local total = lw + rw + 5
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = total,
    height = height,
    col = math.floor((vim.o.columns - total) / 2) - 1,
    row = math.floor((vim.o.lines - height) / 2) - 1,
    border = "rounded",
    style = "minimal",
    title = opts.title and (" " .. opts.title .. " ") or nil,
    title_pos = "center",
  })
  vim.wo[win].wrap = false
  require("corkboard").popup(win)

  -- Keeps the chosen row of each column in view.
  local function scroll(i, top, n)
    if i < top then return i end
    if i > top + height - 1 then return i - height + 1 end
    return math.min(top, math.max(1, n - height + 1))
  end

  local function render()
    local list = rights[li]
    ltop, rtop = scroll(li, ltop, #left), scroll(ri, rtop, #list)
    local lines, marks = {}, {}
    for row = 1, height do
      local l, r = left[ltop + row - 1], list[rtop + row - 1]
      local lt = " " .. fit(l and l.text or "", lw) .. " "
      local text = r and (r.detail and (r.text .. "  " .. r.detail) or r.text) or (row == 1 and #list == 0 and "—" or "")
      local rt = " " .. fit(text, rw) .. " "
      lines[row] = lt .. "│" .. rt
      local rstart = #lt + #"│"
      if l and ltop + row - 1 == li then
        table.insert(marks, { row - 1, 0, #lt, side == "left" and "PmenuSel" or "Visual" })
      end
      if r and rtop + row - 1 == ri and side == "right" then
        table.insert(marks, { row - 1, rstart, #lines[row], "PmenuSel" })
      elseif r and r.detail then
        local at = rstart + 1 + #r.text + 2
        table.insert(marks, { row - 1, math.min(at, #lines[row]), #lines[row], "Comment" })
      elseif not r and row == 1 and #list == 0 then
        table.insert(marks, { row - 1, rstart, #lines[row], "Comment" })
      end
    end
    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
    for _, m in ipairs(marks) do
      vim.api.nvim_buf_set_extmark(buf, ns, m[1], m[2], { end_col = m[3], hl_group = m[4] })
    end
    local row = side == "left" and li - ltop + 1 or ri - rtop + 1
    pcall(vim.api.nvim_win_set_cursor, win, { row, side == "left" and 1 or #(" " .. fit("", lw) .. " │ ") })
  end

  local function close() pcall(vim.api.nvim_win_close, win, true) end
  local function run(item)
    if opts.key then pcall(save_last, opts.key, left[li].text, item.text) end
    close()
    vim.schedule(item.run)
  end
  local function move(by)
    if side == "left" then
      li = math.max(1, math.min(#left, li + by))
      ri = 1
    else
      ri = math.max(1, math.min(#rights[li], ri + by))
    end
    render()
  end
  local function right()
    if side == "right" then
      local item = rights[li][ri]
      if item then run(item) end
    elseif #rights[li] > 0 then
      side, ri = "right", 1
      render()
    end
  end
  local function back()
    side = "left"
    render()
  end

  local function map(keys, fn)
    for _, lhs in ipairs(keys) do vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true }) end
  end
  map({ "j", "<Down>", "<C-n>" }, function() move(1) end)
  map({ "k", "<Up>", "<C-p>" }, function() move(-1) end)
  map({ "l", "<Right>", "<Tab>", "<CR>" }, right)
  map({ "h", "<Left>", "<S-Tab>" }, back)
  map({ "q", "<Esc>" }, close)
  map({ "<LeftMouse>" }, function()
    local p = vim.fn.getmousepos()
    if p.winid ~= win then return close() end
    if p.line < 1 then return end
    if p.column <= lw + 2 then
      local i = ltop + p.line - 1
      if not left[i] then return end
      li, ri, side = i, 1, #rights[i] > 0 and "right" or "left"
      render()
    else
      local item = rights[li][rtop + p.line - 1]
      if item then run(item) end
    end
  end)
  render()
end

return M
