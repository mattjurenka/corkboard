-- Small helpers shared across corkboard's modules.

local M = {}

-- $XDG_DATA_HOME/corkboard/..., where boards and worktrees live.
function M.data_dir(...)
  local base = vim.env.XDG_DATA_HOME or vim.fs.joinpath(vim.uv.os_homedir(), ".local/share")
  return vim.fs.joinpath(base, "corkboard", ...)
end

-- A path as one directory name: /home/me/proj -> home-me-proj.
function M.path_key(path)
  return (path:gsub("^/", ""):gsub("/", "-"))
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
