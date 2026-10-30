-- Pickers, from snacks.nvim, set up for corkboard: no backdrop (a full-screen
-- float would cut the panels away), and a file picked from a panel opens in a
-- split beside it (a tab, when narrow) rather than replacing it.

local M = {}

local function on_panel(win)
  return win and vim.api.nvim_win_is_valid(win) and require("corkboard").is_panel(vim.api.nvim_win_get_buf(win))
end

local function confirm(picker, item, action)
  local cmd = action and action.cmd
  if not on_panel(picker.main) or (cmd and cmd ~= "vsplit") then
    return Snacks.picker.actions.jump(picker, item, action)
  end
  local main, items = picker.main, picker:selected({ fallback = true })
  vim.cmd.stopinsert()
  picker:close()
  vim.schedule(function()
    vim.api.nvim_set_current_win(main)
    local split = require("corkboard").narrow() and "$tabedit " or "rightbelow vsplit "
    for _, it in ipairs(items) do
      vim.cmd(split .. vim.fn.fnameescape(Snacks.picker.util.path(it)))
      if it.pos then pcall(vim.api.nvim_win_set_cursor, 0, it.pos) end
    end
  end)
end

-- Files open in the window the picker was opened from, except a terminal,
-- which a file would replace; from there snacks chooses.
function M.files()
  Snacks.picker.files({ main = { current = vim.bo.buftype ~= "terminal" } })
end

-- Repos sit directly under home here; g:corkboard_project_dirs says otherwise.
local function dev_dirs() return vim.g.corkboard_project_dirs or { "~" } end

local function no_project() return vim.fn.getcwd() == vim.uv.os_homedir() end

-- With no project open yet (the cwd is home), the chosen one becomes this
-- window's with a global :cd, so the board and every tab follow. With one
-- open, it opens in a window of its own: the page's, or with no page, nil.
local function go(path)
  if not no_project() then return { path = path } end
  vim.cmd.cd(vim.fn.fnameescape(path))
  vim.notify("Project: " .. vim.fn.fnamemodify(path, ":~"))
  return { opened = true }
end

local function nil_if_null(v) return v ~= vim.NIL and v or nil end

-- host/owner/repo, however a remote is written (scp-like, ssh://, https://).
local function repo_of(url)
  return (url:lower():gsub("^%w+://", ""):gsub("^[^@/]+@", ""):gsub("^([^/:]+):(%d*)/?", function(host, port) return host .. "/" end):gsub("%.git/?$", ""):gsub("/$", ""))
end

-- A clone here of one of these remotes: among the recent projects, or under a
-- project directory by the repository's name.
local function clone_of(remotes, recent)
  local util = require("corkboard.util")
  local want = {}
  for _, r in ipairs(remotes) do want[repo_of(r)] = true end
  local candidates = vim.list_extend({}, recent)
  for _, r in ipairs(remotes) do
    local name = repo_of(r):match("([^/]+)$")
    for _, d in ipairs(dev_dirs()) do
      if name then table.insert(candidates, vim.fs.joinpath(vim.fn.expand(d), name)) end
    end
  end
  for _, dir in ipairs(candidates) do
    if vim.fn.isdirectory(dir) == 1 then
      local ok, out = util.git({ "config", "--get-regexp", "^remote\\..*\\.url$" }, dir)
      for url in (ok and out or ""):gmatch("%S+%s+(%S+)") do
        if want[repo_of(url)] then return dir end
      end
    end
  end
end

-- The account's projects (its boards that have one), for the page's Open
-- project window (web/src/components/Projects.tsx). Each at its clone on this
-- machine if there is one. A clone is found by its first commit, at the
-- board's own root or among the recent projects, as cards/cloud.lua finds its
-- board. Those with a remote come first, as the portal lists them, and a
-- clone's own origin stands in for a board that hasn't recorded one; a
-- project with neither a clone here nor a remote can't be opened, so isn't
-- listed. Within each, the projects opened most recently first.
function M.account_projects()
  local util = require("corkboard.util")
  local ok, boards = pcall(require("corkboard.cards.cloud").boards)
  -- Where a new one named rather than given a path goes.
  local dir = vim.fn.fnamemodify(vim.fn.expand(dev_dirs()[1]), ":~")
  if not ok then return { error = tostring(boards), dir = dir } end
  local recent = require("corkboard").recent_projects()
  local rank = {}
  for i, dir in ipairs(recent) do rank[dir] = i end
  local out = {}
  for _, b in ipairs(boards) do
    local root, commit = nil_if_null(b.root), nil_if_null(b.commit)
    local remotes = nil_if_null(b.remotes) or {}
    -- A board made in the portal has remotes and no root: the first
    -- machine to open it clones it, so a clone here goes by its remotes.
    if root or #remotes > 0 then
      local function clone(dir) return vim.fn.isdirectory(dir) == 1 and (not commit or util.project_commit(dir) == commit) end
      local path = root and clone(root) and root or nil
      if not path and commit then
        for _, dir in ipairs(recent) do
          if clone(dir) then
            path = dir
            break
          end
        end
      end
      if not path and not commit and #remotes > 0 then path = clone_of(remotes, recent) end
      local remote = remotes[1]
      if not remote and path then
        local got, url = util.git({ "remote", "get-url", "origin" }, path)
        remote = got and vim.trim(url) ~= "" and vim.trim(url) or nil
      end
      if path or remote then
        table.insert(out, {
          key = b.key,
          name = b.name,
          root = root,
          path = path,
          where = path and vim.fn.fnamemodify(path, ":~"),
          remote = remote,
        })
      end
    end
  end
  table.sort(out, function(a, b)
    if not a.remote ~= not b.remote then return a.remote ~= nil end
    local ra, rb = a.path and rank[a.path] or math.huge, b.path and rank[b.path] or math.huge
    if ra ~= rb then return ra < rb end
    return a.name:lower() < b.name:lower()
  end)
  return { projects = out, dir = dir }
end

-- A project from account_projects(), cloned here first from its remote when
-- this machine has none, beside the other projects. The clone is pinned to
-- the board (util.lua's pinned_board), as the bridge pins one it clones: a
-- board made in the portal has no first commit to be found by.
function M.open_project(p)
  local util = require("corkboard.util")
  local function pinned(path)
    if p.key and not util.pinned_board(path) then util.git({ "config", "corkboard.board", p.key }, path) end
    return go(path)
  end
  if p.path and vim.fn.isdirectory(p.path) == 1 then return pinned(p.path) end
  if not p.remote then return { error = p.name .. " isn't on this machine and has no remote to clone" } end
  local root = nil_if_null(p.root)
  local name = root and vim.fs.basename(root) or repo_of(p.remote):match("([^/]+)$")
  local dest = vim.fs.joinpath(vim.fn.expand(dev_dirs()[1]), name)
  if vim.uv.fs_stat(dest) then return { error = vim.fn.fnamemodify(dest, ":~") .. " is already there" } end
  local ok, _, err = util.git({ "clone", p.remote, dest })
  if not ok then return { error = err } end
  return pinned(dest)
end

-- A new project: a name, beside the other projects, or a path. The folder is
-- made if it isn't there and made a repository if it isn't one, and gets a
-- board in the account unless its repository has one already.
function M.new_project(text)
  local util = require("corkboard.util")
  text = vim.trim(text)
  if text == "" then return { error = "No name" } end
  local path = text:match("^[/~]") and vim.fn.expand(text) or vim.fs.joinpath(vim.fn.expand(dev_dirs()[1]), text)
  path = vim.fs.normalize(path)
  if vim.fn.isdirectory(path) == 0 and vim.fn.mkdir(path, "p") == 0 then return { error = "Can't make " .. vim.fn.fnamemodify(path, ":~") } end
  if util.repo_root(path) ~= path then
    local ok, _, err = util.git({ "init" }, path)
    if not ok then return { error = err } end
  end
  local cloud = require("corkboard.cards.cloud")
  if cloud.enabled() then
    local commit = util.project_commit(path)
    local ok, boards = pcall(cloud.boards)
    local has = ok and vim.iter(boards):any(function(b) return b.key == util.path_key(path) or (commit and b.commit == commit) end)
    if ok and not has then
      local made, err = pcall(cloud.make, util.path_key(path), vim.fs.basename(path), path)
      if not made then vim.notify("corkboard: " .. tostring(err), vim.log.levels.WARN) end
    end
  end
  return go(path)
end

-- On the page, its Open project window; in a bare Neovim, a snacks picker of
-- the projects here.
local function projects()
  local corkboard = require("corkboard")
  if corkboard.attached() then
    corkboard.notify("corkboard.projects", { here = not no_project() })
    return
  end
  Snacks.picker.projects({
    dev = dev_dirs(),
    projects = corkboard.recent_projects(),
    confirm = function(picker, item)
      picker:close()
      if not item then return end
      if not go(item.file).opened then corkboard.notify("corkboard.open", { cwd = item.file }) end
    end,
  })
end

-- The tool picker (<C-Space>, <M-Space>). Each runs in the window it was opened from.
local tools = {
  {
    text = "New buffer",
    hint = "",
    run = function(main) vim.cmd(on_panel(main) and "rightbelow vnew" or "enew") end,
  },
  { text = "Open file", hint = "<C-f>", run = M.files },
  { text = "Open project", hint = "", run = projects },
  {
    text = "Card from this line",
    hint = "<leader>c",
    run = function()
      local lnum = vim.api.nvim_win_get_cursor(0)[1]
      require("corkboard.board").card_from_code(lnum, lnum)
    end,
  },
  { text = "Token usage", hint = "<leader>u", run = function() require("corkboard.usage").show() end },
  { text = "Day plan", hint = "<leader>p", run = function() require("corkboard.plan").show() end },
  { text = "Claude Code", hint = "<C-.>", run = function() require("corkboard.claude").open() end },
  { text = "Away mode", hint = "<leader>a", run = function() require("corkboard.away").enter() end },
  { text = "Terminal", hint = "", run = function() require("corkboard.terminal").tab() end },
  { text = "Reload window", hint = "F5", run = function() require("corkboard.restore").reload() end },
}

local function run(main, item)
  vim.schedule(function()
    if vim.api.nvim_win_is_valid(main) then vim.api.nvim_set_current_win(main) end
    item.run(main)
  end)
end

-- On the page the tools are a window of the page's (web/src/components/
-- Tools.tsx), which calls run() with the one chosen; in a bare Neovim, a
-- snacks picker.
local opened_from

function M.run(i)
  if tools[i] and opened_from then run(opened_from, tools[i]) end
end

function M.tools()
  -- Not picker.main: snacks skips the board's scratch buffer when it picks a
  -- main window, and would choose a terminal instead.
  local main = vim.api.nvim_get_current_win()
  local corkboard = require("corkboard")
  if corkboard.attached() then
    opened_from = main
    local leader = vim.g.mapleader or "\\"
    corkboard.notify("corkboard.tools", {
      leader = leader == " " and "Space" or leader,
      tools = vim.tbl_map(function(t) return { text = t.text, hint = t.hint } end, tools),
    })
    return
  end
  Snacks.picker.pick({
    source = "corkboard_tools",
    -- Copies: snacks keeps match state on the items.
    items = vim.tbl_map(vim.deepcopy, tools),
    format = function(item)
      return { { item.text }, { item.hint ~= "" and "  " .. item.hint or "", "Comment" } }
    end,
    layout = { preset = "select" },
    confirm = function(picker, item)
      picker:close()
      if item then run(main, item) end
    end,
  })
end

function M.setup()
  local ok, snacks = pcall(require, "snacks")
  if not ok then return false end
  snacks.setup({
    picker = {
      enabled = true,
      layout = { layout = { backdrop = false } },
      actions = { confirm = confirm },
    },
  })
  return true
end

return M
