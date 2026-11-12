-- Columns in a float: a choice in each, and to its right what that choice
-- offers, which follows its cursor. j/k move in a column; l, <Tab> or <CR>
-- go right, h or <S-Tab> back; <CR> on a choice that offers nothing more
-- runs it. A click chooses there and goes right, or runs it.

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

-- The last choice in each keyed pick, its texts column by column, kept
-- across restarts so the next open starts on it.
local function last_path() return vim.fs.joinpath(vim.fn.stdpath("state"), "corkboard", "columns.json") end

local function read_last()
  local f = io.open(last_path(), "r")
  if not f then return {} end
  local ok, got = pcall(vim.json.decode, f:read("*a"))
  f:close()
  return ok and type(got) == "table" and got or {}
end

local function save_last(key, path)
  local all = read_last()
  all[key] = { path = path }
  vim.fn.mkdir(vim.fs.dirname(last_path()), "p")
  local f = io.open(last_path(), "w")
  if not f then return end
  f:write(vim.json.encode(all))
  f:close()
end

local function label(it) return it.detail and (it.text .. "  " .. it.detail) or it.text end

-- opts: title; items, the first column's: a list of { text, detail?, run }
-- or { text, items }, items a list or a function(item) giving one; key, to
-- open on the last choice made in a pick with the same key.
function M.pick(opts)
  if #opts.items == 0 then return end
  -- Each item's own, once, and each column's width from all it may show.
  local widths, rows = {}, #opts.items
  local function expand(list, depth)
    widths[depth] = widths[depth] or 0
    for _, it in ipairs(list) do
      widths[depth] = math.max(widths[depth], width(label(it)))
      if type(it.items) == "function" then it.items = it.items(it) or {} end
      if it.items then
        rows = math.max(rows, #it.items)
        expand(it.items, depth + 1)
      end
    end
  end
  expand(opts.items, 1)
  local n = #widths
  local others = 0
  for k = 1, n - 1 do others = others + widths[k] + 3 end
  widths[n] = math.max(math.min(widths[n], vim.o.columns - others - 6), 12)
  local height = math.max(math.min(rows, vim.o.lines - 6), 1)

  -- The column the cursor is in, and the row chosen in each.
  local at, sel, tops = 1, {}, {}
  for k = 1, n do sel[k], tops[k] = 1, 1 end
  -- What column k shows, from the choices left of it; nil past the last.
  local function column(k)
    local list = opts.items
    for j = 1, k - 1 do
      local it = list[sel[j]]
      list = it and it.items
      if not list then return nil end
    end
    return list
  end

  local last = opts.key and read_last()[opts.key]
  for k, text in ipairs(last and type(last.path) == "table" and last.path or {}) do
    local list = column(k)
    local found = list and vim.iter(ipairs(list)):find(function(_, it) return it.text == text end)
    if not found then break end
    sel[k], at = found, k
  end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "wipe"
  local total = others + widths[n] + 2
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
  local function scroll(i, top, count)
    if i < top then return i end
    if i > top + height - 1 then return i - height + 1 end
    return math.min(top, math.max(1, count - height + 1))
  end

  -- Where column k starts in a line, in bytes and in cells.
  local starts, cells = {}, {}

  local function render()
    local lists = {}
    for k = 1, n do
      lists[k] = column(k)
      if lists[k] then tops[k] = scroll(sel[k], tops[k], #lists[k]) end
    end
    local lines, marks = {}, {}
    for row = 1, height do
      local line, cell = "", 0
      for k = 1, n do
        if k > 1 then
          line, cell = line .. "│", cell + 1
        end
        starts[k], cells[k] = #line, cell
        local list = lists[k]
        local i = tops[k] + row - 1
        local it = list and list[i]
        local text = it and label(it) or (list and row == 1 and #list == 0 and "—" or "")
        local part = " " .. fit(text, widths[k]) .. " "
        line, cell = line .. part, cell + widths[k] + 2
        local from, to = starts[k], #line
        if it and i == sel[k] and k < at then
          table.insert(marks, { row - 1, from, to, "Visual" })
        elseif it and i == sel[k] and k == at then
          table.insert(marks, { row - 1, from, to, "PmenuSel" })
        elseif it and it.detail then
          table.insert(marks, { row - 1, math.min(from + 1 + #it.text + 2, to), to, "Comment" })
        elseif not it and list and row == 1 and #list == 0 then
          table.insert(marks, { row - 1, from, to, "Comment" })
        end
      end
      lines[row] = line
    end
    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
    for _, m in ipairs(marks) do
      vim.api.nvim_buf_set_extmark(buf, ns, m[1], m[2], { end_col = m[3], hl_group = m[4] })
    end
    pcall(vim.api.nvim_win_set_cursor, win, { sel[at] - tops[at] + 1, starts[at] + 1 })
  end

  local function close() pcall(vim.api.nvim_win_close, win, true) end
  local function run(it)
    if opts.key then
      local path = {}
      for k = 1, at do path[k] = column(k)[sel[k]].text end
      pcall(save_last, opts.key, path)
    end
    close()
    vim.schedule(it.run)
  end
  local function move(by)
    local list = column(at)
    sel[at] = math.max(1, math.min(#list, sel[at] + by))
    for k = at + 1, n do sel[k], tops[k] = 1, 1 end
    render()
  end
  -- Into what the choice offers, or run it when it offers nothing more.
  local function right()
    local it = column(at)[sel[at]]
    if not it then return end
    if it.items then
      if #it.items == 0 then return end
      at = at + 1
      return render()
    end
    if it.run then run(it) end
  end
  local function back()
    at = math.max(1, at - 1)
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
    local k = n
    while k > 1 and p.column <= cells[k] do k = k - 1 end
    local list = column(k)
    local i = list and tops[k] + p.line - 1
    if not (list and list[i]) then return end
    sel[k], at = i, k
    for j = k + 1, n do sel[j], tops[j] = 1, 1 end
    local it = list[i]
    if not it.items and it.run then return run(it) end
    if it.items and #it.items > 0 then at = k + 1 end
    render()
  end)
  render()
end

return M
