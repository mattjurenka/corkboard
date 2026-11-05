-- Reviewing a card's work (the board's v): agent://review/<id>, an HTML view
-- (b:corkboard_view "review") in a float over the board. Its state is what
-- the browser draws: where the branch merges and how big it is, what would
-- stop the merge, the reviewer's verdict, the agent's summary of the work
-- and what it did after, each changed file with its diff, the commits, and
-- the request and full log to unfold. A approves, S sends it back, q
-- closes; j/k and friends scroll it. A click on a diff line opens that file
-- in a tab of its own, leaving the review over the board.
--
-- Approving merges the card's branch into the main checkout's current
-- branch (--no-ff, so the card stays one merge), removes the worktree and
-- the branch, and moves the card to done. Sending it back takes you to the
-- agent's session to say what to change, starting a new one in the same
-- worktree if none is running.

local cards = require("corkboard.cards")
local util = require("corkboard.util")

local M = {}

local function board() return require("corkboard.board") end

local git = util.git

-- Past this a file's diff is cut short in the view.
local MAX_DIFF_LINES = 2000

-- The main checkout, and its current branch ("" when detached), for the
-- card's worktree.
local function main_checkout(worktree)
  local root = util.repo_root(worktree)
  if not root then return nil, "" end
  local _, branch = git({ "symbolic-ref", "--short", "HEAD" }, root)
  return root, vim.trim(branch)
end

-- Where the card's work is: its worktree (HEAD there, uncommitted work
-- included), or, the worktree gone, its branch in the main checkout. nil
-- when there is neither.
local function source(card)
  local wt = card.worktree
  if wt and wt ~= "" and vim.fn.isdirectory(wt) == 1 then
    local root, main = main_checkout(wt)
    return { dir = wt, rev = "HEAD", worktree = wt, root = root, main = main }
  end
  local branch = card.branch
  if not branch or branch == "" then return nil end
  local root, main = main_checkout(util.project_root())
  if not (root and git({ "rev-parse", "--verify", "--quiet", "refs/heads/" .. branch }, root)) then return nil end
  return { dir = root, rev = branch, root = root, main = main }
end

local function nonempty(text)
  return vim.tbl_filter(function(l) return l ~= "" end, vim.split(vim.trim(text), "\n", { plain = true }))
end

-- A diff as files, each with its lines as { kind, text, new-side line }:
-- kind "@" for a hunk header, "+", "-" or " ".
local function parse_diff(diff)
  local files, file, new_line = {}, nil, nil
  for line in vim.gsplit(diff, "\n", { plain = true }) do
    if line:match("^diff ") then
      file = { path = line:match(" b/(.*)$") or line, status = "M", added = 0, removed = 0, lines = {} }
      table.insert(files, file)
      new_line = nil
    elseif file and not new_line then
      if line:match("^new file") then file.status = "A" end
      if line:match("^deleted file") then file.status = "D" end
      if line:match("^rename to ") then file.status, file.path = "R", line:match("^rename to (.*)$") end
      if line:match("^Binary files") then file.binary = true end
    end
    if file and line:match("^@@") then
      new_line = tonumber(line:match("^@@ %-%d+,?%d* %+(%d+)")) or 1
      table.insert(file.lines, { "@", line, new_line })
    elseif file and new_line and not line:match("^diff ") then
      local kind = line:sub(1, 1)
      if kind == "+" or kind == "-" or kind == " " then
        if kind == "+" then file.added = file.added + 1 end
        if kind == "-" then file.removed = file.removed + 1 end
        if #file.lines < MAX_DIFF_LINES then
          table.insert(file.lines, { kind, line:sub(2), kind ~= "-" and new_line or vim.NIL })
        else
          file.truncated = true
        end
        if kind ~= "-" then new_line = new_line + 1 end
      end
    end
  end
  return files
end

-- The card's log as entries, oldest first.
local function log_entries(card)
  local entries = {}
  local notes = cards.section(card, "NOTES")
  if notes == "" then return entries end
  for entry in vim.gsplit((notes:gsub("^%- ", "")), "\n- ", { plain = true }) do
    entry = entry:gsub("\n  ", "\n")
    local month, day, time, who, text = entry:match("^%d+%-(%d+)%-(%d+)T(%d+:%d+):%d+Z ([^:]+): (.*)$")
    table.insert(entries, text and { time = month .. "-" .. day .. " " .. time, who = who, text = text } or { text = entry })
  end
  return entries
end

-- What the browser draws for the card's review.
local function state(card)
  local s = {
    id = card.id,
    title = card.title,
    branch = card.branch,
    description = cards.section(card, "DESCRIPTION"),
    log = log_entries(card),
    files = {},
    commits = {},
  }

  -- The agent's latest submit_for_review is its summary of the work: the
  -- summary, then "Verified: ...". What it logged after is listed under it.
  for i = #s.log, 1, -1 do
    local summary, verified = s.log[i].text:match("^(.-)\nVerified: (.*)$")
    if summary then
      s.summary = { time = s.log[i].time, text = summary, verified = verified }
      s.after = vim.list_slice(s.log, i + 1)
      break
    end
  end

  local r = require("corkboard.autopilot").last_review(card.id)
  if r and (r.error or (r.summary or "") ~= "") then
    s.reviewer = { risk = r.risk, summary = r.error or r.summary, problems = r.problems, error = r.error ~= nil }
  end

  local src = source(card)
  if not src then return s end
  local main, dir, rev = src.main, src.dir, src.rev
  s.main = main ~= "" and main or nil
  s.dir = dir
  s.gone = not src.worktree
  local _, base = git({ "merge-base", main ~= "" and main or "HEAD", rev }, dir)
  base = vim.trim(base)
  -- In a worktree the diff takes in what isn't committed yet.
  local range = src.worktree and { base } or { base, rev }
  local _, diff = git(vim.list_extend({ "diff" }, range), dir)
  s.files = parse_diff(diff)
  local _, log_out = git({ "log", "--format=%h %s", base .. ".." .. rev }, dir)
  for _, l in ipairs(nonempty(log_out)) do
    local sha, subject = l:match("^(%S+) (.*)$")
    table.insert(s.commits, { sha = sha, subject = subject })
  end
  if src.worktree then
    local _, status = git({ "status", "--short" }, dir)
    s.uncommitted = nonempty(status)
  end

  -- What would stop the merge: conflicts with the main branch, and
  -- uncommitted changes in the main checkout to files the card touches.
  if main ~= "" and src.root then
    local ok, out = git({ "merge-tree", "--write-tree", "--name-only", main, card.branch or rev }, src.root)
    if not ok then
      local conflicts = {}
      for i, l in ipairs(vim.split(out, "\n", { plain = true })) do
        if i > 1 then
          if l == "" then break end
          table.insert(conflicts, l)
        end
      end
      if #conflicts > 0 then s.conflicts = conflicts end
    end
    local _, status = git({ "status", "--porcelain" }, src.root)
    local touched = {}
    for _, f in ipairs(s.files) do touched[f.path] = true end
    local dirty = {}
    for _, l in ipairs(nonempty(status)) do
      local path = l:sub(4):gsub("^.* %-> ", "")
      if touched[path] then table.insert(dirty, path) end
    end
    if #dirty > 0 then s.dirty = dirty end
  end
  return s
end

local function close(buf)
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do pcall(vim.api.nvim_win_close, win, true) end
  pcall(vim.api.nvim_buf_delete, buf, { force = true })
end

-- opts.confirm = false merges without asking (autopilot's low-risk merge).
function M.approve(id, done, opts)
  local confirm = not (opts and opts.confirm == false)
  local card = board().get(id)
  local src, branch = source(card), card.branch
  if not src then
    board().set(id, { status = "done", agent_state = "done", attention = "" })
    board().log(id, "user", "approved")
    return done and done()
  end
  local status = ""
  if src.worktree then _, status = git({ "status", "--porcelain" }, src.worktree) end
  if vim.trim(status) ~= "" then
    return vim.notify("corkboard: " .. id .. "'s worktree has uncommitted changes; have the agent commit them, or send it back", vim.log.levels.WARN)
  end
  local root, main = src.root, src.main
  if not root or main == "" then
    return vim.notify("corkboard: the main checkout has no branch checked out to merge " .. id .. " into", vim.log.levels.WARN)
  end
  local function merge()
    local ok, out, err = git({ "merge", "--no-ff", "-m", string.format("Merge %s: %s", id, card.title), branch }, root)
    if not ok then
      git({ "merge", "--abort" }, root)
      board().set(id, { attention = "merging " .. branch .. " failed; resolve it in the worktree and approve again" })
      board().log(id, "user", "merge of " .. branch .. " into " .. main .. " failed:\n" .. vim.trim(err ~= "" and err or out))
      return vim.notify("corkboard: merging " .. branch .. " failed: " .. (err ~= "" and err or vim.trim(out)), vim.log.levels.ERROR)
    end
    local _, sha = git({ "rev-parse", "--short", "HEAD" }, root)
    local wt = src.worktree
    local removed, rm_err = true, ""
    if wt then removed, _, rm_err = git({ "worktree", "remove", wt }, root) end
    if removed then git({ "branch", "-d", branch }, root) end
    board().set(id, { status = "done", agent_state = "done", attention = "", worktree = removed and "" or wt })
    board().log(id, confirm and "user" or "reviewer", string.format("%s: merged %s into %s (%s)%s",
      confirm and "approved" or "low risk, merged by itself", branch, main, vim.trim(sha),
      removed and "" or ("; the worktree is still there: " .. rm_err)))
    vim.notify("corkboard: " .. id .. " merged into " .. main)
    if done then done() end
  end
  if not confirm then return merge() end
  vim.ui.select({ "Merge " .. branch .. " into " .. main .. " and finish " .. id, "Cancel" }, { prompt = "Approve " .. id }, function(_, i)
    if i == 1 then merge() end
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

local open_buf -- the review showing, if any

-- A file of the review, at a line, in a tab of its own.
function M.open_file(path, line)
  vim.cmd("tabedit " .. vim.fn.fnameescape(path))
  pcall(vim.api.nvim_win_set_cursor, 0, { line or 1, 0 })
end

-- The view's buttons.
function M.action(id, name)
  local buf = open_buf
  local function finish() if buf then close(buf) end end
  if name == "approve" then M.approve(id, finish) end
  if name == "send_back" then M.send_back(id, finish) end
  if name == "close" then finish() end
end

function M.open(id)
  local card = board().get(id)
  local name = "agent://review/" .. id
  local buf = vim.fn.bufnr(name)
  if buf ~= -1 then close(buf) end
  buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, name)
  vim.bo[buf].bufhidden = "wipe"
  vim.b[buf].corkboard_view = "review"
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "Review " .. id .. "  " .. card.title })
  vim.bo[buf].modifiable = false
  open_buf = buf
  local s = state(card)

  local width = math.min(120, vim.o.columns - 6)
  local height = vim.o.lines - 6
  vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = width,
    height = height,
    col = math.floor((vim.o.columns - width) / 2) - 1,
    row = math.floor((vim.o.lines - height) / 2) - 1,
    border = "rounded",
    title = " Review " .. id .. " ",
    title_pos = "center",
  })
  local notify = function(st) require("corkboard").notify("corkboard.view", buf, st) end
  notify(s)
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = buf,
    once = true,
    callback = function()
      if open_buf == buf then open_buf = nil end
    end,
  })

  local function map(lhs, fn, desc) vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true, desc = "review: " .. desc }) end
  local function finish() close(buf) end
  map("q", finish, "close")
  map("<Esc>", finish, "close")
  map("A", function() M.approve(id, finish) end, "approve and merge")
  map("S", function() M.send_back(id, finish) end, "send back")
  -- Scrolling, in lines; "top" and "bottom" go to the ends.
  local seq = 0
  local function scroll(by)
    return function()
      seq = seq + 1
      notify({ scroll = { by = by, seq = seq } })
    end
  end
  local half = math.floor(height / 2)
  for lhs, by in pairs({ j = 1, k = -1, ["<Down>"] = 1, ["<Up>"] = -1, ["<C-e>"] = 1, ["<C-y>"] = -1,
    ["<C-d>"] = half, ["<C-u>"] = -half, ["<C-f>"] = height, ["<C-b>"] = -height, ["<Space>"] = height,
    G = "bottom", gg = "top" }) do
    map(lhs, scroll(by), "scroll")
  end
end

return M
