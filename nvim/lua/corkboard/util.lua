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

-- Run git; returns ok, stdout (untrimmed: diffs need their whitespace), stderr.
function M.git(args, cwd)
  local result = vim.system(vim.list_extend({ "git" }, args), { cwd = cwd, text = true }):wait()
  return result.code == 0, result.stdout or "", vim.trim(result.stderr or "")
end

-- The main checkout of the repository dir is in, from any worktree; nil
-- outside one.
function M.repo_root(dir)
  local ok, common = M.git({ "rev-parse", "--path-format=absolute", "--git-common-dir" }, dir)
  return ok and vim.fs.dirname(vim.trim(common)) or nil
end

return M
