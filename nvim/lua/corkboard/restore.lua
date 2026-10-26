-- The editor as it was: its tabs, their splits and what each window shows,
-- kept beside the project's board (editor.json) and put back when the next
-- Neovim for the project starts, as it does on every page reload.
--
-- The bridge stops Neovim with SIGTERM, which runs no autocommands, so the
-- state is written whenever it changes rather than on the way out.
--
-- Files reopen where the cursor was; shells start again in their directory;
-- Claude Code sessions, a card's agent's too, are resumed. The pinned tabs
-- (board, usage, the day plan) make themselves, and the panels that open
-- beside something (a markdown preview, a session's cards) open with it, so
-- neither is kept. Neither is Pepper, whom the day plan's window brings.

local M = {}

local PINNED = { corkboard_board = true, corkboard_usage = true, corkboard_plan = true }

local function path()
  if require("corkboard").window == "plan" then return require("corkboard.util").data_dir("plan", "editor.json") end
  return vim.fs.joinpath(require("corkboard.cards").dir(), "editor.json")
end

-- Not until the saved state has been put back, or the empty editor would
-- overwrite it first.
local restored = false

-- What a window shows, as restore() can make it again; nil to leave it out.
local function leaf(win)
  local buf = vim.api.nvim_win_get_buf(win)
  local b, name = vim.b[buf], vim.api.nvim_buf_get_name(buf)
  local l = { width = vim.api.nvim_win_get_width(win), height = vim.api.nvim_win_get_height(win) }
  l.focus = win == vim.api.nvim_get_current_win() or nil
  if vim.bo[buf].buftype == "terminal" then
    if b.corkboard_plan_claude or b.corkboard_claude == "pepper" then return nil end
    l.cwd = name:match("^term://(.-)//%d+:")
    if b.corkboard_claude then
      if not b.corkboard_claude_session then return nil end
      l.type, l.session = "claude", b.corkboard_claude_session
      -- A card it was started on, or one it took later (agents.link).
      if b.corkboard_linked then
        l.linked = b.corkboard_card
      else
        l.card = b.corkboard_card
      end
      l.transcript = b.corkboard_claude_transcript
    else
      l.type = "terminal"
      l.toggle = buf == vim.t.corkboard_terminal or nil
    end
  elseif b.corkboard_file or (vim.bo[buf].buftype == "" and name ~= "") then
    local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
    l.type, l.path, l.lnum, l.col, l.topline = "file", name, view.lnum, view.col, view.topline
  elseif vim.bo[buf].buftype == "" and not b.corkboard_view then
    l.type = "empty"
  else
    return nil
  end
  return l
end

-- winlayout()'s tree, with the windows it leaves out dropped and a split
-- left with one window in it folded away.
local function tree(node)
  if node[1] == "leaf" then
    local l = leaf(node[2])
    return l and { "leaf", l }
  end
  local kids = {}
  for _, child in ipairs(node[2]) do
    local t = tree(child)
    if t then table.insert(kids, t) end
  end
  if #kids == 0 then return nil end
  if #kids == 1 then return kids[1] end
  return { node[1], kids }
end

function M.state()
  local tabs = {}
  for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
    local pinned = false
    for key in pairs(PINNED) do
      pinned = pinned or vim.t[tab][key] == true
    end
    -- Focus mode's tab is a second look at a window kept in another tab.
    if not pinned and not vim.t[tab].corkboard_focus then
      local t = tree(vim.fn.winlayout(vim.api.nvim_tabpage_get_number(tab)))
      if t then table.insert(tabs, { layout = t, terminal = vim.t[tab].corkboard_terminal_tab or nil }) end
    end
  end
  return { tabs = tabs, current = vim.fn.tabpagenr(), columns = vim.o.columns, lines = vim.o.lines }
end

-- Home is where corkboard lands without a project; it keeps no state.
local function homeless()
  return require("corkboard").window ~= "plan" and vim.fn.getcwd(-1, -1) == vim.uv.os_homedir()
end

local last
function M.save()
  if not restored or homeless() or vim.v.exiting ~= vim.NIL then return end
  local ok, text = pcall(function() return vim.json.encode(M.state()) end)
  if not ok or text == last then return end
  last = text
  local file = path()
  vim.fn.mkdir(vim.fs.dirname(file), "p")
  pcall(vim.fn.writefile, { text }, file)
end

local timer
local function save_soon()
  if not restored then return end
  timer = timer or assert(vim.uv.new_timer())
  timer:start(300, 0, vim.schedule_wrap(M.save))
end

-- Restoring ---------------------------------------------------------------------

local function fill(win, l)
  vim.api.nvim_set_current_win(win)
  if l.type == "file" then
    if vim.fn.filereadable(l.path) == 0 then return end
    vim.cmd.edit(vim.fn.fnameescape(l.path))
    pcall(vim.fn.winrestview, { lnum = l.lnum, col = l.col, topline = l.topline })
  elseif l.type == "terminal" then
    vim.cmd.enew()
    local cwd = l.cwd and vim.fn.isdirectory(vim.fn.expand(l.cwd)) == 1 and vim.fn.expand(l.cwd) or nil
    vim.fn.jobstart({ vim.o.shell }, { term = true, cwd = cwd })
    if l.toggle then
      vim.bo.bufhidden = "hide"
      vim.t.corkboard_terminal = vim.api.nvim_get_current_buf()
    end
  elseif l.type == "claude" then
    -- A session that never got a prompt wrote no transcript, and --resume
    -- would only say there is no such session: a new one instead.
    local session = l.session
    if l.transcript and not vim.uv.fs_stat(vim.fn.expand(l.transcript)) then session = nil end
    if l.card then
      local ok, card = pcall(require("corkboard.board").get, l.card)
      if ok and card then require("corkboard.agents").start(l.card, { resume = session, here = true }) end
    else
      local cwd = l.cwd and vim.fn.expand(l.cwd)
      local buf = require("corkboard.claude").start({ cwd = cwd, args = session and { "--resume", session } or nil, here = true })
      local ok, card = pcall(require("corkboard.board").get, l.linked or "")
      if buf and l.linked and ok and card and card.status ~= "done" then require("corkboard.agents").link(buf, l.linked) end
    end
  end
end

-- Splits win as node says, and fills each window; returns the leaves with
-- the windows made for them.
local function build(node, win, out)
  if node[1] == "leaf" then
    table.insert(out, { win = win, leaf = node[2] })
    fill(win, node[2])
    return
  end
  -- Every sibling first, so a child's own splits stay inside its window.
  local wins = { win }
  for i = 2, #node[2] do
    vim.api.nvim_set_current_win(wins[i - 1])
    vim.cmd(node[1] == "row" and "rightbelow vsplit" or "rightbelow split")
    wins[i] = vim.api.nvim_get_current_win()
  end
  for i, child in ipairs(node[2]) do
    build(child, wins[i], out)
  end
end

-- Each window to its old size, scaled to the editor's size now. Twice, as
-- each resize moves its neighbours.
local function resize(placed, saved)
  local sx, sy = vim.o.columns / (saved.columns or vim.o.columns), vim.o.lines / (saved.lines or vim.o.lines)
  for _ = 1, 2 do
    for _, p in ipairs(placed) do
      if vim.api.nvim_win_is_valid(p.win) then
        pcall(vim.api.nvim_win_set_width, p.win, math.max(1, math.floor(p.leaf.width * sx + 0.5)))
        pcall(vim.api.nvim_win_set_height, p.win, math.max(1, math.floor(p.leaf.height * sy + 0.5)))
      end
    end
  end
end

local function put_back()
  if restored then return end
  if homeless() then
    restored = true
    return
  end
  local ok, lines = pcall(vim.fn.readfile, path())
  local saved = ok and vim.F.npcall(vim.json.decode, table.concat(lines, "\n"))
  if type(saved) ~= "table" or type(saved.tabs) ~= "table" then
    restored = true
    return
  end
  -- The pinned tabs first, so the restored ones go after them.
  local corkboard = require("corkboard")
  if corkboard.window == "plan" then
    require("corkboard.plan").ensure()
  else
    require("corkboard.board").ensure()
    require("corkboard.usage").ensure()
  end

  local focus
  for _, tab in ipairs(saved.tabs) do
    local made, err = pcall(function()
      vim.cmd("$tabnew")
      local empty = vim.api.nvim_get_current_buf()
      local placed = {}
      build(tab.layout, vim.api.nvim_get_current_win(), placed)
      if tab.terminal then vim.t.corkboard_terminal_tab = true end
      if #vim.fn.win_findbuf(empty) == 0 then pcall(vim.api.nvim_buf_delete, empty, {}) end
      resize(placed, saved)
      for _, p in ipairs(placed) do
        if p.leaf.focus then focus = p.win end
      end
    end)
    if not made then vim.notify("corkboard: restoring a tab: " .. tostring(err), vim.log.levels.WARN) end
  end

  if saved.current and saved.current <= vim.fn.tabpagenr("$") then vim.cmd.tabnext(saved.current) end
  if focus and vim.api.nvim_win_is_valid(focus) and vim.api.nvim_win_get_tabpage(focus) == vim.api.nvim_get_current_tabpage() then
    vim.api.nvim_set_current_win(focus)
  end
  restored = true
  save_soon()
end

-- Whether the saved state has been put back; until then the page shows
-- the tabs and windows it saw last, each loading.
function M.restored() return restored end

-- The terminals put back that have drawn nothing yet (a Claude Code session
-- takes a moment to), for the page to show loading; for a few seconds at
-- most, as a terminal can be blank on purpose.
local settling = false
local function blank(buf)
  for _, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    if line:find("%S") then return false end
  end
  return true
end

local function drawn()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[buf].buftype == "terminal" and vim.api.nvim_buf_is_loaded(buf) and blank(buf) then return false end
  end
  return true
end

function M.loading(buf) return settling and vim.bo[buf].buftype == "terminal" and blank(buf) end

function M.restore()
  settling = true
  local ok, err = pcall(put_back)
  if not ok then
    restored = true
    vim.notify("corkboard: restoring the editor: " .. tostring(err), vim.log.levels.WARN)
  end
  local deadline = vim.uv.now() + 3000
  local function check()
    if not drawn() and vim.uv.now() < deadline then return vim.defer_fn(check, 50) end
    settling = false
    require("corkboard").push_layout()
  end
  check()
end

-- The tool picker's Reload window: this state saved, then the page reloaded,
-- which starts a new Neovim that puts it back.
function M.reload()
  M.save()
  require("corkboard").notify("corkboard.reload")
end

function M.setup()
  local group = vim.api.nvim_create_augroup("corkboard.restore", {})
  vim.api.nvim_create_autocmd({
    "TabNew", "TabClosed", "TabEnter", "WinNew", "WinClosed", "WinEnter", "WinResized",
    "BufWinEnter", "CursorHold", "CursorHoldI", "TermOpen",
  }, { group = group, callback = save_soon })
  -- A project opened from home (Open project's :cd): its own state comes
  -- back, beside what is already open, rather than this overwriting it.
  vim.api.nvim_create_autocmd("DirChanged", {
    group = group,
    callback = function()
      if vim.v.event.scope ~= "global" or not restored then return end
      restored, last = false, nil
      vim.schedule(M.restore)
    end,
  })
end

return M
