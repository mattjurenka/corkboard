-- Reviewing a card's work (the board's v): agent://review/<id> in a tab of
-- its own, with the card's description and latest log, then what its
-- branch changed against where it left the main branch, uncommitted work
-- in its worktree included. A plain text buffer: <CR> on a diff line opens
-- that file in the worktree there, A approves, S sends it back, q closes.
--
-- Approving merges the card's branch into the main checkout's current
-- branch (--no-ff, so the card stays one merge), removes the worktree and
-- the branch, and moves the card to done. Sending it back logs the comment,
-- and either types it into the agent's session if one is running, or
-- queues the card again so a new agent starts with it.

local M = {}

local function board() return require("corkboard.board") end

local function git(args, cwd)
  local result = vim.system(vim.list_extend({ "git" }, args), { cwd = cwd, text = true }):wait()
  return result.code == 0, result.stdout or "", vim.trim(result.stderr or "")
end

-- The main checkout, and its current branch, for the card's worktree.
local function main_checkout(worktree)
  local ok, common = git({ "rev-parse", "--path-format=absolute", "--git-common-dir" }, worktree)
  if not ok then return nil end
  local root = vim.fs.dirname(vim.trim(common))
  local _, branch = git({ "symbolic-ref", "--short", "HEAD" }, root)
  return root, vim.trim(branch)
end

local function section_text(body, name)
  return vim.trim((body or ""):match("<!%-%- SECTION:" .. name .. ":BEGIN %-%->\n?(.-)<!%-%- SECTION:" .. name .. ":END %-%->") or "")
end

-- The review's lines, and for diff lines the worktree file and line they
-- stand for.
local function render(card)
  local lines, targets = {}, {}
  local function add(text)
    for line in vim.gsplit(text, "\n", { plain = true }) do table.insert(lines, line) end
  end
  add(string.format("Review  %s  %s", card.id, card.title))
  add("A approve and merge · S send back · <CR> open file · q close")
  add("")
  local description = section_text(card.body, "DESCRIPTION")
  if description ~= "" then add("## Description\n\n" .. description .. "\n") end
  local log = vim.split(section_text(card.body, "NOTES"), "\n- ", { plain = true })
  if #log > 0 and log[1] ~= "" then
    add("## Latest log\n")
    for i = math.max(1, #log - 2), #log do add((i == 1 and "" or "- ") .. log[i]) end
    add("")
  end

  local wt = card.worktree
  if not (wt and wt ~= "" and vim.fn.isdirectory(wt) == 1) then
    add("No worktree: the card's agent worked in the project itself, so there is no branch to diff.")
    return lines, targets
  end
  local root, main = main_checkout(wt)
  local _, base = git({ "merge-base", main ~= "" and main or "HEAD", "HEAD" }, wt)
  base = vim.trim(base)
  local _, status = git({ "status", "--short" }, wt)
  local _, log_out = git({ "log", "--oneline", base .. "..HEAD" }, wt)
  local _, stat = git({ "diff", "--stat", base }, wt)
  local _, diff = git({ "diff", base }, wt)
  add(string.format("## %s, against %s (%s)\n", card.branch or "?", main ~= "" and main or "HEAD", root or "?"))
  if vim.trim(log_out) ~= "" then add(vim.trim(log_out) .. "\n") end
  if vim.trim(status) ~= "" then add("Uncommitted in the worktree:\n" .. status:gsub("\n$", "") .. "\n") end
  add(vim.trim(stat) ~= "" and (vim.trim(stat) .. "\n") or "No changes.\n")

  -- Map each diff line to its file and new-side line number.
  local file, new_line
  for line in vim.gsplit(diff, "\n", { plain = true }) do
    table.insert(lines, line)
    local path = line:match("^%+%+%+ b/(.*)$")
    if path then
      file = vim.fs.joinpath(wt, path)
    elseif line:match("^@@") then
      new_line = tonumber(line:match("^@@ %-%d+,?%d* %+(%d+)"))
      targets[#lines] = file and { file, new_line or 1 }
    elseif file and new_line and not line:match("^diff ") and not line:match("^index ") and not line:match("^%-%-%- ") then
      local mark = line:sub(1, 1)
      targets[#lines] = { file, new_line }
      if mark ~= "-" then new_line = new_line + 1 end
    end
  end
  return lines, targets
end

local function close_tab(buf)
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    local tab = vim.api.nvim_win_get_tabpage(win)
    if #vim.api.nvim_list_tabpages() > 1 then pcall(vim.cmd.tabclose, vim.api.nvim_tabpage_get_number(tab)) end
  end
  pcall(vim.api.nvim_buf_delete, buf, { force = true })
end

function M.approve(id, done)
  local card = board().get(id)
  local wt, branch = card.worktree, card.branch
  if not (wt and wt ~= "" and vim.fn.isdirectory(wt) == 1) then
    board().set(id, { status = "done", agent_state = "done", attention = "" })
    board().log(id, "user", "approved")
    return done and done()
  end
  local _, status = git({ "status", "--porcelain" }, wt)
  if vim.trim(status) ~= "" then
    return vim.notify("corkboard: " .. id .. "'s worktree has uncommitted changes; have the agent commit them, or send it back", vim.log.levels.WARN)
  end
  local root, main = main_checkout(wt)
  vim.ui.select({ "Merge " .. branch .. " into " .. main .. " and finish " .. id, "Cancel" }, { prompt = "Approve " .. id }, function(_, i)
    if i ~= 1 then return end
    local ok, out, err = git({ "merge", "--no-ff", "-m", string.format("Merge %s: %s", id, card.title), branch }, root)
    if not ok then
      git({ "merge", "--abort" }, root)
      board().set(id, { attention = "merging " .. branch .. " failed; resolve it in the worktree and approve again" })
      board().log(id, "user", "merge of " .. branch .. " into " .. main .. " failed:\n" .. vim.trim(err ~= "" and err or out))
      return vim.notify("corkboard: merging " .. branch .. " failed: " .. (err ~= "" and err or vim.trim(out)), vim.log.levels.ERROR)
    end
    local _, sha = git({ "rev-parse", "--short", "HEAD" }, root)
    local removed, _, rm_err = git({ "worktree", "remove", wt }, root)
    if removed then git({ "branch", "-d", branch }, root) end
    board().set(id, { status = "done", agent_state = "done", attention = "", worktree = removed and "" or wt })
    board().log(id, "user", string.format("approved: merged %s into %s (%s)%s", branch, main, vim.trim(sha),
      removed and "" or ("; the worktree is still there: " .. rm_err)))
    vim.notify("corkboard: " .. id .. " merged into " .. main)
    if done then done() end
  end)
end

-- What needs changing is said in the agent's session: its own, or a new
-- one in the same worktree, told to wait for it.
function M.send_back(id, done)
  board().log(id, "user", "sent back from review")
  local agents = require("corkboard.agents")
  if done then done() end
  if agents.session(id) then
    board().set(id, { status = "doing", agent_state = "working", attention = "" })
    agents.attend(id)
  else
    board().set(id, { status = "doing", agent_state = "queued", attention = "" })
    agents.start(id, { sent_back = true })
  end
end

function M.open(id)
  local card = board().get(id)
  local name = "agent://review/" .. id
  local buf = vim.fn.bufnr(name)
  if buf ~= -1 then close_tab(buf) end
  vim.cmd.tabnew()
  buf = vim.api.nvim_get_current_buf()
  vim.api.nvim_buf_set_name(buf, name)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  local lines, targets = render(card)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = "diff"

  local function map(lhs, fn, desc) vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true, desc = "review: " .. desc }) end
  local function finish() close_tab(buf) end
  map("q", finish, "close")
  map("A", function() M.approve(id, finish) end, "approve and merge")
  map("S", function() M.send_back(id, finish) end, "send back")
  map("<CR>", function()
    local target = targets[vim.api.nvim_win_get_cursor(0)[1]]
    if not target then return end
    vim.cmd("rightbelow vsplit " .. vim.fn.fnameescape(target[1]))
    pcall(vim.api.nvim_win_set_cursor, 0, { target[2], 0 })
  end, "open file at this line")
end

return M
