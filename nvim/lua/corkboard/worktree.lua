-- Agents' git worktrees (.agent/plans/worktrees-prs.md): each session works
-- in one of its own, on agent/<name>/work from the main checkout's HEAD,
-- so nothing it does edits the user's tree.

local util = require("corkboard.util")

local M = {}

-- The worktree called name of the repository root is the main checkout
-- of, and its branch; made the first time, the same one after. branch:
-- one to use in place of agent/<name>/work, when it's there (a card's old
-- card/<id>).
function M.make(root, name, branch)
  local dir = util.data_dir("worktrees", util.path_key(root), name)
  local has = function(b) return util.git({ "rev-parse", "--verify", "--quiet", "refs/heads/" .. b }, root) end
  if not (branch and has(branch)) then branch = "agent/" .. name .. "/work" end
  if vim.fn.isdirectory(dir) == 1 then return dir, branch end
  vim.fn.mkdir(vim.fs.dirname(dir), "p")
  local args = has(branch) and { "worktree", "add", dir, branch } or { "worktree", "add", "-b", branch, dir }
  local ok, _, err = util.git(args, root)
  if not ok then error("git worktree add: " .. err, 0) end
  return dir, branch
end

-- Whether dir is in a linked worktree (one of these, or the user's own)
-- rather than a main checkout.
function M.linked(dir)
  local ok, out = util.git({ "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir" }, dir)
  if not ok then return false end
  local git_dir, common = unpack(vim.split(vim.trim(out), "\n"))
  return git_dir ~= common
end

-- A new session's worktree, for one that would start in dir: nil when dir
-- is outside a repository or already in a linked worktree. Gives the
-- directory to start in (dir's place in the worktree), its branch, and
-- what to tell the agent.
function M.for_session(dir)
  local root = util.repo_root(dir)
  if not root or M.linked(dir) then return nil end
  local name = os.date("%m%d-%H%M%S")
  local tree, branch = M.make(root, name)
  local sub = util.is_under(dir, root) and dir:sub(#root + 2) or ""
  local cwd = sub ~= "" and vim.fs.joinpath(tree, sub) or tree
  if vim.fn.isdirectory(cwd) == 0 then cwd = tree end
  local note = string.format(
    "You work in a git worktree of your own, %s, on branch %s, made from %s's HEAD."
      .. " Commit your work on that branch and push it to origin; don't edit %s, the user's own checkout."
      .. " Untracked files there (dependencies, .env) aren't in the worktree; install or ask for what you need."
      .. " When the work is ready, open a pull request with open_pr; another session reviews it (review_pr) before you merge it with merge_pr, unless the user merges it.",
    tree, branch, root, root
  )
  return cwd, branch, note
end

-- After branch's pull request is merged into base on the forge: its
-- worktree (wt, if any) removed unless something in it is uncommitted, the
-- branch deleted, and the main checkout at root fast-forwarded to the new
-- base when it's on base and clean. Gives what it couldn't do, one line
-- each.
function M.finish(root, wt, branch, base)
  local left = {}
  util.git({ "fetch", "--quiet", "origin" }, root)
  if wt and wt ~= "" and vim.fn.isdirectory(wt) == 1 then
    local ok, _, err = util.git({ "worktree", "remove", wt }, root)
    if not ok then table.insert(left, "the worktree is still there: " .. err) end
  end
  if #left == 0 and branch and branch ~= "" then util.git({ "branch", "-D", branch }, root) end
  local _, on = util.git({ "symbolic-ref", "--short", "HEAD" }, root)
  local _, status = util.git({ "status", "--porcelain", "--untracked-files=no" }, root)
  if vim.trim(on) ~= base then
    table.insert(left, root .. " is on " .. vim.trim(on) .. ", not " .. base .. "; pull it yourself")
  elseif vim.trim(status) ~= "" then
    table.insert(left, root .. " has uncommitted changes, so it wasn't brought up to " .. base)
  else
    local ok, _, err = util.git({ "merge", "--ff-only", "--quiet", "origin/" .. base }, root)
    if not ok then table.insert(left, root .. " couldn't fast-forward to origin/" .. base .. ": " .. err) end
  end
  return left
end

-- A worktree done with unmerged (its card archived): removed with its
-- branch when nothing in it is uncommitted or only here. Gives why not
-- when it's kept.
function M.drop(wt, branch)
  if not (wt and wt ~= "" and vim.fn.isdirectory(wt) == 1) then return end
  local root = util.repo_root(wt)
  local _, status = util.git({ "status", "--porcelain" }, wt)
  if vim.trim(status) ~= "" then return wt .. " has uncommitted changes, so it's kept" end
  -- Its commits that no remote nor any other branch has.
  local _, only = util.git({ "rev-list", "--count", "HEAD", "--not", "--remotes", "--exclude=" .. (branch or "HEAD"), "--branches" }, wt)
  if (tonumber(vim.trim(only)) or 0) > 0 then return wt .. " has commits on no other branch and not pushed, so it's kept" end
  local ok, _, err = util.git({ "worktree", "remove", wt }, root)
  if not ok then return "the worktree is still there: " .. err end
  if branch and branch ~= "" then util.git({ "branch", "-D", branch }, root) end
end

-- The forge's owner/repo of dir's origin, when origin is the node's forge
-- (http://127.0.0.1:<port>/forge/<owner>/<repo>.git).
function M.forge_repo(dir)
  local ok, url = util.git({ "remote", "get-url", "origin" }, dir)
  if not ok then return nil end
  local repo = vim.trim(url):match("^https?://[^/]+/forge/([^/]+/[^/]+)$")
  return repo and (repo:gsub("%.git$", ""))
end

-- The node's MCP config for a session in a linked worktree (a file:
-- CORKBOARD_MEMORY_MCP_CONFIG's, and a corkboard-forge server beside it
-- with the PR tools, told the session's branch and repo); otherwise the
-- shared one. Rewritten at every start, so it follows the node's token.
function M.mcp_config(dir)
  local shared = vim.env.CORKBOARD_MEMORY_MCP_CONFIG
  if not (shared and dir and M.linked(dir)) then return shared end
  local ok, branch = util.git({ "symbolic-ref", "--short", "HEAD" }, dir)
  local fd = io.open(shared)
  if not (ok and fd) then return shared end
  local config = vim.json.decode(fd:read("*a"))
  fd:close()
  local memory = config.mcpServers and config.mcpServers["corkboard-memory"]
  if not memory then return shared end
  local headers = vim.tbl_extend("force", memory.headers or {}, { ["X-Corkboard-Branch"] = vim.trim(branch), ["X-Corkboard-Repo"] = M.forge_repo(dir) })
  config.mcpServers["corkboard-forge"] = vim.tbl_extend("force", memory, { url = (memory.url:gsub("%?.*$", "")) .. "?tools=forge", headers = headers })
  local path = util.state_dir("session-mcp", util.path_key(util.repo_root(dir) or dir) .. "--" .. vim.trim(branch):gsub("/", "-") .. ".json")
  vim.fn.mkdir(vim.fs.dirname(path), "p")
  local out = assert(vim.uv.fs_open(path, "w", tonumber("600", 8)))
  vim.uv.fs_write(out, vim.json.encode(config))
  vim.uv.fs_close(out)
  vim.uv.fs_chmod(path, tonumber("600", 8))
  return path
end

return M
