-- Small helpers shared across corkboard's modules.

local M = {}

local windows = vim.fn.has("win32") == 1

-- corkboard's own directories, as the bridge found them for this OS
-- (bridge/dirs.ts) and passed them on; without a bridge, XDG's.
local function dir(kind, xdg, default)
  local given = vim.env["CORKBOARD_" .. kind:upper() .. "_DIR"]
  if given and given ~= "" then return given end
  return vim.fs.joinpath(vim.env[xdg] or vim.fs.joinpath(vim.uv.os_homedir(), default), "corkboard")
end

-- $XDG_DATA_HOME/corkboard/..., where boards and worktrees live.
function M.data_dir(...) return vim.fs.joinpath(dir("data", "XDG_DATA_HOME", ".local/share"), ...) end

-- $XDG_STATE_HOME/corkboard/..., which the bridge reads too.
function M.state_dir(...) return vim.fs.joinpath(dir("state", "XDG_STATE_HOME", ".local/state"), ...) end

-- Write text to path off the main loop: into a file beside it, renamed into
-- place, so no reader sees half of it. Rewriting a file in place waits, on a
-- busy disk (and on dm-crypt, always), for its pages' last write to reach
-- the disk, and every key waits with it. Writes to one path go in order; a
-- second asked for while one is under way replaces any already waiting. A
-- write that fails leaves the file as it was.
local busy = {} -- path -> true while a write or delete is under way
local waiting = {} -- path -> what to do once it's done: text, or false to delete
local latest = {} -- path -> the last asked for, until it's done (M.read_lines)
local function start(path, text)
  local function done()
    local again = waiting[path]
    waiting[path] = nil
    if again ~= nil then return start(path, again) end
    busy[path], latest[path] = nil, nil
  end
  if text == false then return vim.uv.fs_unlink(path, done) end
  -- Of this Neovim's own: another's writing the same file can't mix in.
  local tmp = ("%s.tmp.%d.%x"):format(path, vim.uv.os_getpid(), math.random(0, 0x7fffffff))
  local function fail() vim.uv.fs_unlink(tmp, done) end
  vim.uv.fs_open(tmp, "w", tonumber("644", 8), function(err, fd)
    if err then return done() end
    vim.uv.fs_write(fd, text, 0, function(write_err, n)
      vim.uv.fs_close(fd, function(close_err)
        if write_err or close_err or n ~= #text then return fail() end
        vim.uv.fs_rename(tmp, path, function(rename_err)
          if rename_err then return fail() end
          done()
        end)
      end)
    end)
  end)
end

local function later(path, text)
  latest[path] = text
  if busy[path] then
    waiting[path] = text
    return
  end
  busy[path] = true
  start(path, text)
end

function M.write_later(path, text) later(path, text) end

-- Delete path in the same queue, after any write to it asked for before.
function M.delete_later(path) later(path, false) end

-- path's lines, as they'll be once what's on its way is done; nil if
-- there's no such file.
function M.read_lines(path)
  local text = latest[path]
  if text == false then return nil end
  if text then return vim.split(text, "\n", { trimempty = true }) end
  local ok, lines = pcall(vim.fn.readfile, path)
  return ok and lines or nil
end

-- Whether every write_later is on disk.
function M.written() return next(busy) == nil end

-- What's still being written is finished first.
vim.api.nvim_create_autocmd("VimLeavePre", {
  group = vim.api.nvim_create_augroup("corkboard.util", {}),
  callback = function() vim.wait(2000, M.written, 5) end,
})

-- A path as one directory name: /home/me/proj -> home-me-proj; on Windows
-- C:\Users\me\proj -> C-Users-me-proj. As pathKey in bridge/dirs.ts.
function M.path_key(path)
  if windows then return (path:gsub("^(%a):", "%1"):gsub("^[\\/]+", ""):gsub("[\\/:]", "-")) end
  return (path:gsub("^/", ""):gsub("/", "-"))
end

-- Whether path is inside dir. On Windows either may have either separator
-- (git's are /, the OS's \), so both are made /.
function M.is_under(path, dir_)
  if windows then path, dir_ = path:gsub("\\", "/"), dir_:gsub("\\", "/") end
  return #path > #dir_ and path:sub(1, #dir_) == dir_ and path:sub(#dir_ + 1, #dir_ + 1) == "/"
end

-- Where to reach this Neovim: its server, or the bridge's stand-in for
-- one when it runs in the page (corkboard.wasm).
function M.server() return vim.g.corkboard_server or vim.v.servername end

-- A Neovim that runs on this machine, for hooks to run as `nvim -l`: this
-- one, unless it is the page's.
function M.progpath() return vim.g.corkboard_nvim or vim.v.progpath end

-- Run git; returns ok, stdout (untrimmed: diffs need their whitespace), stderr.
function M.git(args, cwd)
  local result = vim.system(vim.list_extend({ "git" }, args), { cwd = cwd, text = true }):wait()
  return result.code == 0, result.stdout or "", vim.trim(result.stderr or "")
end

-- The main checkout of the repository dir is in, from any worktree; nil
-- outside one. A submodule's common dir is in its parent's .git/modules, so
-- it is its own top level.
function M.repo_root(dir)
  local ok, out = M.git({ "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel" }, dir)
  if not ok then return nil end
  local common, top = unpack(vim.split(vim.trim(out), "\n"))
  if vim.fs.basename(common) == ".git" then return vim.fs.dirname(common) end
  return top ~= "" and top or nil
end

-- No project open: the window's global cwd is home, where corkboard lands
-- before one is (the day plan's window has none to want). The board, Claude
-- Code and terminals wait for one (corkboard.projects).
function M.no_project()
  return require("corkboard").window ~= "plan" and vim.fn.getcwd(-1, -1) == vim.uv.os_homedir()
end

-- The project dir is in: its repository's main checkout, so a subdirectory
-- or a worktree shares the repository's board; dir itself outside one. A
-- home that is a repository (dotfiles) is not one project.
local roots = {}
function M.project_root(dir)
  dir = dir or vim.fn.getcwd()
  if not roots[dir] then
    local root = M.repo_root(dir)
    roots[dir] = (root and root ~= vim.uv.os_homedir()) and root or dir
  end
  return roots[dir]
end

-- The project's board key, as the file boards name their directories.
function M.project_key(dir) return M.path_key(M.project_root(dir)) end

-- The project's first commit: the same in every clone, whatever remotes it
-- has or hasn't. The oldest, when unrelated histories were merged; nil
-- outside a repository or before its first commit.
local commits = {}
function M.project_commit(root)
  if commits[root] == nil then
    local ok, out = M.git({ "log", "--max-parents=0", "--format=%ct %H", "HEAD" }, root)
    local first
    for t, hash in (ok and out or ""):gmatch("(%d+) (%x+)") do
      if not first or tonumber(t) < first.t or (tonumber(t) == first.t and hash < first.hash) then first = { t = tonumber(t), hash = hash } end
    end
    -- Not remembered while there's none: the first commit will make one.
    if not first then return nil end
    commits[root] = first.hash
  end
  return commits[root]
end

-- The board this clone is pinned to (git config corkboard.board), for a
-- fork beside its upstream, or history rewritten past the first commit.
function M.pinned_board(root)
  local ok, out = M.git({ "config", "--get", "corkboard.board" }, root)
  return ok and vim.trim(out) ~= "" and vim.trim(out) or nil
end

return M
