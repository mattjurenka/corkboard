-- The projects: the account's (a board each, corkboard.picker's
-- account_projects) and the ones opened on this machine that have none, most
-- recent first. Each is a folder, its repository and its board, one to one.
--
-- The view is the agent://projects buffer, first among the tabs: a plain
-- listing with the browser's HTML drawn over it. The cursor's line selects a
-- project. <CR> opens it (here while no project is open, else in a window of
-- its own), n makes a new one in the page's Open project window, x forgets
-- one from this machine's recent projects, R asks again.
--
-- With no project open (util.no_project), corkboard starts here, and what
-- belongs to a project (the board, Claude Code, terminals, cards) waits for
-- one: need() brings this tab forward instead.

local pinned = require("corkboard.pinned")
local util = require("corkboard.util")

local M = {}

local buf
local line_item = {} -- line number -> project id (its path, or its board's key)
local selected
local projects -- as listed() made them, nil until asked
local problem
local dir = "~" -- where a new one named rather than given a path goes

local function nil_if_null(v)
  if v == vim.NIL then return nil end
  return v
end

local function id_of(p) return p.path or p.key end

local function find(id)
  return vim.iter(projects or {}):find(function(p) return id_of(p) == id end)
end

-- The account's projects, then the recent ones that aren't among them.
local function listed()
  local recent = require("corkboard").recent_projects()
  local rank = {}
  for i, d in ipairs(recent) do rank[d] = i end
  local out, seen, err = {}, {}, nil
  local ok, got = pcall(require("corkboard.picker").account_projects)
  if ok and got then
    dir = got.dir or dir
    err = got.error
    for _, p in ipairs(got.projects or {}) do
      p.board = p.key
      if p.path then seen[p.path] = true end
      table.insert(out, p)
    end
  else
    err = tostring(got)
  end
  for _, d in ipairs(recent) do
    if not seen[d] then
      local got_url, url = util.git({ "remote", "get-url", "origin" }, d)
      table.insert(out, {
        name = vim.fs.basename(d),
        path = d,
        where = vim.fn.fnamemodify(d, ":~"),
        remote = got_url and vim.trim(url) ~= "" and vim.trim(url) or nil,
      })
    end
  end
  for _, p in ipairs(out) do
    p.root = nil_if_null(p.root)
    p.recent = p.path and rank[p.path] ~= nil or nil
  end
  return out, err
end

-- What the page is sent.
local function state()
  local here = not util.no_project() and util.project_root(vim.fn.getcwd(-1, -1)) or nil
  local list = {}
  for _, p in ipairs(projects or {}) do
    table.insert(list, {
      id = id_of(p), name = p.name, path = p.path, where = p.where, remote = p.remote, board = p.board,
      recent = p.recent, current = (here and p.path == here) or nil,
    })
  end
  return {
    projects = list, selected = selected, problem = problem, dir = dir,
    none = util.no_project() or nil, loading = (not projects and not problem) or nil,
  }
end

local function push_state() require("corkboard").notify("corkboard.projects_view", state()) end

local function render_text()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local s = state()
  local lines, map = { "Projects" .. string.rep(" ", 40) .. "n new project", "" }, {}
  if s.problem then table.insert(lines, "  " .. s.problem) end
  if s.loading then table.insert(lines, "  looking…") end
  if not s.loading and #s.projects == 0 then table.insert(lines, "  No projects yet.") end
  for _, p in ipairs(s.projects) do
    table.insert(lines, "  " .. p.name .. (p.current and "  ● open here" or ""))
    map[#lines] = p.id
    table.insert(lines, "    " .. (p.where or "not on this machine"))
    if p.remote then table.insert(lines, "    " .. p.remote) end
    table.insert(lines, "    <CR> open" .. (p.recent and " · x forget" or ""))
    table.insert(lines, "")
  end
  pinned.set_lines(buf, lines)
  line_item = map
  pinned.follow(buf, line_item, selected)
end

local function redraw()
  render_text()
  push_state()
end

function M.load()
  local list, err = listed()
  projects, problem = list, (#list == 0 and err) or nil
  if not selected or not find(selected) then selected = projects[1] and id_of(projects[1]) end
  redraw()
end

function M.select(id, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(line_item, id)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
  selected = id
  redraw()
end

-- On the page, which opens it (a window of its own first, while a project
-- is open here, so the popup blocker lets it through); in a bare Neovim,
-- here or as Open project does.
function M.open(id)
  local p = find(id or selected)
  if not p then return end
  local ui = require("corkboard")
  if ui.attached() then return ui.notify("corkboard.project_open", { project = p, here = not util.no_project() }) end
  local picker = require("corkboard.picker")
  local r = p.board and picker.open_project(p) or picker.open_path(p.path)
  if r.error then return vim.notify("corkboard: " .. r.error, vim.log.levels.ERROR) end
  if r.path then ui.notify("corkboard.open", { cwd = r.path }) end
end

function M.new()
  local ui = require("corkboard")
  if ui.attached() then return ui.notify("corkboard.projects", { here = not util.no_project(), naming = true }) end
  vim.ui.input({ prompt = "New project (name or path): " }, function(text)
    if not text or vim.trim(text) == "" then return end
    local r = require("corkboard.picker").new_project(text)
    if r.error then return vim.notify("corkboard: " .. r.error, vim.log.levels.ERROR) end
    if r.path then ui.notify("corkboard.open", { cwd = r.path }) end
  end)
end

function M.forget(id)
  local p = find(id or selected)
  if not (p and p.recent) then return end
  require("corkboard").forget_project(p.path)
  M.load()
end

local function items() return line_item end

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  buf = pinned.listing("agent://projects", "projects", {
    j = { pinned.nav("down", items, function() pinned.step(line_item, 1) end), "down" },
    k = { pinned.nav("up", items, function() pinned.step(line_item, -1) end), "up" },
    h = { pinned.nav("left", items, function() pinned.step(line_item, -1) end), "left" },
    l = { pinned.nav("right", items, function() pinned.step(line_item, 1) end), "right" },
    ["<CR>"] = { function() M.open() end, "open it" },
    n = { M.new, "a new project" },
    x = { function() M.forget() end, "forget it here" },
    R = { M.load, "refresh" },
  }, items, function(id)
    if id == selected then return end
    selected = id
    redraw()
  end)
  vim.api.nvim_create_autocmd("BufEnter", { buffer = buf, callback = function() vim.schedule(M.load) end })
  return buf
end

function M.ensure()
  if pinned.ensure("corkboard_projects", pinned.index("corkboard_projects"), buffer()) then vim.schedule(M.load) end
end

function M.show()
  M.ensure()
  pinned.show("corkboard_projects", pinned.index("corkboard_projects"), buffer())
end

-- For what needs a project: true, with this tab brought forward, while
-- there's none.
function M.need()
  if not util.no_project() then return false end
  M.show()
  return true
end

-- A project opened here: the list says so.
function M.changed()
  if buf and vim.api.nvim_buf_is_valid(buf) then redraw() end
end

function M.push_all()
  if buf and vim.api.nvim_buf_is_valid(buf) then push_state() end
end

return M
