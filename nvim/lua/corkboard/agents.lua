-- Agents on cards. Handing a card to an agent (the board's a) queues it;
-- whenever the board changes, queued cards whose dependencies are done start,
-- up to g:corkboard_max_agents at once (default 3). Each gets a git worktree
-- on branch card/task-<n> and Claude Code in a tab, told to work on the card
-- through the corkboard MCP.
--
-- Sessions belong to this Neovim and end with it; a card still queued then
-- starts again the next time the board is open.

local util = require("corkboard.util")
local terminal = require("corkboard.terminal")

local M = {}

local function board() return require("corkboard.board") end

local sessions = {} -- card id -> terminal buffer of its running session
local starting = {} -- card ids schedule() has queued to start
-- terminal buffer -> working | background (its turn is over but work it
-- started still runs) | ready (it waits on you) | idle (a fresh session) |
-- asking | permission
local live = {}
local pending = {} -- terminal buffer -> { [tool_use_id] = true } of background work
local waking = {} -- terminal buffer -> true when this turn scheduled a /loop wakeup
local exited = {} -- card ids whose session has ended

-- The card's running session's terminal, if any.
function M.session(id)
  if terminal.alive(sessions[id]) then return sessions[id] end
  -- The job can end before its TermClose (on_exit in start()) runs.
  if sessions[id] then exited[id] = true end
  sessions[id] = nil
end

-- A Claude Code terminal's state, from its hooks: nil before the first, and
-- for a session run somewhere else (corkboard.claude's via), which has none.
function M.state(buf) return live[buf] end

-- The card's session state for the board: live's, "starting" before its
-- first hook, "exited", or nil when it has had no session here.
function M.live(id)
  local buf = M.session(id)
  if buf then return live[buf] or "starting" end
  return exited[id] and "exited" or nil
end

local function event_state(ev)
  if ev.event == "PreToolUse" and ev.tool_name == "AskUserQuestion" then return "asking" end
  if ev.event == "Notification" then
    local kind = ev.notification_type or ""
    if kind == "permission_prompt" or (kind == "" and (ev.message or ""):lower():find("permission")) then return "permission" end
    if kind == "idle_prompt" then return "settled" end
    return nil
  end
  return ({
    SessionStart = "idle",
    UserPromptSubmit = "working",
    PreToolUse = "working",
    PostToolUse = "working",
    PermissionRequest = "permission",
    Stop = "settled",
  })[ev.event]
end

-- The task-notifications in the transcript's end, by the tool call that
-- started each: one with a status is that work finished.
local NOTES = 4 * 1024 * 1024
local function finished_tasks(path)
  local done = {}
  local fd = path and vim.uv.fs_open(vim.fn.expand(path), "r", 0)
  if not fd then return done end
  local size = vim.uv.fs_fstat(fd).size
  local text = vim.uv.fs_read(fd, math.min(size, NOTES), math.max(0, size - NOTES)) or ""
  vim.uv.fs_close(fd)
  for note in text:gmatch("<task%-notification>(.-)</task%-notification>") do
    local id = note:match("<tool%-use%-id>([^<]+)</tool%-use%-id>")
    if id and note:find("<status>", 1, true) then done[id] = true end
  end
  return done
end

-- Between turns: still at work while what it started in the background
-- hasn't come back, or a /loop will wake it; otherwise waiting on you.
local function settle(buf, ev)
  local mine = pending[buf]
  if mine and next(mine) then
    for id in pairs(finished_tasks(ev.transcript_path)) do mine[id] = nil end
  end
  return ((mine and next(mine)) or waking[buf]) and "background" or "ready"
end

-- Each card's sessions, in sessions.json beside the board as
-- { [card id] = { { id, transcript, started }, ... } }, so corkboard.usage
-- can add up their cost after they end.
local function sessions_file() return vim.fs.joinpath(board().dir(), "sessions.json") end

function M.card_sessions()
  local ok, text = pcall(vim.fn.readfile, sessions_file())
  if not ok then return {} end
  local decoded = vim.F.npcall(vim.json.decode, table.concat(text, "\n"))
  return type(decoded) == "table" and decoded or {}
end

local function remember(id, session_id, transcript)
  local all = M.card_sessions()
  local list = all[id] or {}
  for _, s in ipairs(list) do
    if s.id == session_id then return end
  end
  table.insert(list, { id = session_id, transcript = transcript, started = os.time() })
  all[id] = list
  pcall(vim.fn.writefile, { vim.json.encode(all) }, sessions_file())
end

-- Go to what the card's agent wants: its session, where the question is
-- Claude Code's own to answer, or the card when no session runs. Going also
-- lets it past a budget hold (corkboard.budget).
function M.attend(id)
  board().set(id, { attention = "", budget_hold = "" })
  local buf = M.session(id)
  if buf then return terminal.focus(buf) end
  board().reveal(id)
end

-- What the card should say while its session waits on the user.
local function asking(ev)
  if ev.event == "PreToolUse" and ev.tool_name == "AskUserQuestion" then
    return "asks: " .. (ev.question or "a question")
  elseif ev.event == "PermissionRequest" then
    return "wants permission" .. (ev.tool_name and (" for " .. ev.tool_name) or "")
  end
end

-- Past this, a session's context is worth starting fresh (/clear, or a new
-- session with a handoff in the card's log): every request re-reads it all.
-- g:corkboard_context_limit, in tokens.
function M.context_limit() return vim.g.corkboard_context_limit or 200000 end

-- The context of a session's last request: its input, cache writes and
-- cache reads, from the last main-thread assistant record in the
-- transcript. Only the file's end is read, so a long session costs no more.
local TAIL = 512 * 1024
local function last_context(path)
  local fd = path and vim.uv.fs_open(vim.fn.expand(path), "r", 0)
  if not fd then return nil end
  local size = vim.uv.fs_fstat(fd).size
  local text = vim.uv.fs_read(fd, math.min(size, TAIL), math.max(0, size - TAIL)) or ""
  vim.uv.fs_close(fd)
  local lines = vim.split(text, "\n", { plain = true, trimempty = true })
  for i = #lines, 1, -1 do
    local line = lines[i]
    if line:find('"type":"assistant"', 1, true) and line:find('"usage"', 1, true) then
      local record = vim.F.npcall(vim.json.decode, line)
      local usage = record and not record.isSidechain and type(record.message) == "table" and record.message.usage
      if type(usage) == "table" then
        return (usage.input_tokens or 0) + (usage.cache_creation_input_tokens or 0) + (usage.cache_read_input_tokens or 0)
      end
    end
  end
end

-- After each request (and when a session starts afresh, as after /clear):
-- the session's context for its status line, and a word once when it
-- passes the limit.
local function track_context(buf, ev)
  if ev.event == "SessionStart" then vim.b[buf].corkboard_context = nil end
  if ev.event ~= "Stop" and ev.event ~= "PostToolUse" then return vim.cmd.redrawstatus({ bang = true }) end
  local was = vim.b[buf].corkboard_context
  local now = last_context(ev.transcript_path)
  if not now then return end
  vim.b[buf].corkboard_context = now
  local limit = M.context_limit()
  if now >= limit and (was or 0) < limit then
    vim.notify(string.format(
      "corkboard: this Claude session's context is %dk. If the task has changed or it's past %dk, /clear or start a new session, with a short handoff in the card's log.",
      math.floor(now / 1000 + 0.5), math.floor(limit / 1000)), vim.log.levels.WARN)
  end
  vim.cmd.redrawstatus({ bang = true })
end

-- When a session's card is done, the session starts afresh for the next
-- task: corkboard types /clear into it, once it's between turns, and it
-- leaves the card. g:corkboard_clear_when_done = false keeps sessions as
-- they are.
local clearing = {} -- terminal buffer -> the done card it waits to be cleared of

local function between_turns(buf) return live[buf] == nil or live[buf] == "idle" or live[buf] == "ready" end

local function clear(buf)
  local id = clearing[buf]
  clearing[buf] = nil
  if not (id and terminal.alive(buf)) then return end
  if vim.b[buf].corkboard_card == id then M.link(buf, nil) end
  local chan = terminal.job(buf)
  vim.fn.chansend(chan, "/clear")
  -- Claude Code opens its command menu on the /; Enter once it has.
  vim.defer_fn(function()
    if terminal.alive(buf) then vim.fn.chansend(chan, "\r") end
  end, 200)
  vim.notify("corkboard: " .. id .. " is done, so its session was cleared for the next task")
end

-- Whenever the board changes.
function M.finished(cards)
  if vim.g.corkboard_clear_when_done == false then return end
  for _, c in ipairs(cards) do
    local buf = c.status == "done" and M.session(c.id)
    if buf and not clearing[buf] then
      clearing[buf] = c.id
      if between_turns(buf) then vim.schedule(function() clear(buf) end) end
    end
  end
end

-- From a session's hook (hooks/claude-session.lua).
function M.hook(ev)
  local buf = ev.buf
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local id = vim.b[buf].corkboard_card
  -- What corkboard.restore resumes; a /clear starts another.
  if ev.event == "SessionStart" and ev.session_id then
    -- A new session (a /clear) has none of the last one's background work.
    if vim.b[buf].corkboard_claude_session ~= ev.session_id then pending[buf], waking[buf] = nil, nil end
    vim.b[buf].corkboard_claude_session = ev.session_id
    vim.b[buf].corkboard_claude_transcript = ev.transcript_path
  end
  if ev.event == "SessionStart" and id and ev.session_id then remember(id, ev.session_id, ev.transcript_path) end
  -- A session corkboard didn't start on a card took one (claim_card,
  -- next_card) or let it go (release_card) through the corkboard MCP.
  if ev.card and ev.corkboard_tool == "release_card" then
    if id == ev.card then M.link(buf, nil) end
    id = vim.b[buf].corkboard_card
  elseif ev.card and id ~= ev.card then
    M.link(buf, ev.card)
    id = ev.card
  end
  track_context(buf, ev)
  -- When you last said something to it, which away mode orders by.
  if ev.event == "UserPromptSubmit" then vim.b[buf].corkboard_typed = os.time() * 1000 end
  local was = live[buf]
  local state = event_state(ev)
  -- A turn starting: whether it schedules another wakeup is up to it.
  if state == "working" and was ~= "working" then waking[buf] = nil end
  if ev.background and ev.tool_use_id then
    pending[buf] = pending[buf] or {}
    pending[buf][ev.tool_use_id] = true
  end
  if ev.wakeup then waking[buf] = true end
  if state == "settled" then state = settle(buf, ev) end
  if state then
    live[buf] = state
    -- What it waits on, for away mode: a Notification that it still does
    -- doesn't say.
    local waiting = state == "asking" or state == "permission"
    vim.b[buf].corkboard_asking = waiting and (asking(ev) or vim.b[buf].corkboard_asking) or nil
    require("corkboard.away").report()
    -- The tab's mark: a session in a tab off screen draws nothing that
    -- would push it.
    require("corkboard").push_layout()
  end
  -- Its card was done while it was mid-turn.
  if clearing[buf] and between_turns(buf) then return vim.schedule(function() clear(buf) end) end
  if not id then return end
  local question = asking(ev)
  if question then
    -- Setting attention raises the page's notification (attention.ts).
    board().set(id, { agent_state = "blocked", attention = question })
  elseif (was == "asking" or was == "permission") and state and state ~= "asking" and state ~= "permission" then
    -- Answered (or refused) in the session.
    local card = board().get(id)
    board().set(id, { agent_state = card.agent_state == "blocked" and "working" or card.agent_state, attention = "" })
  elseif state and state ~= was then
    board().redraw()
  end
end

function M.running()
  local n = 0
  for id in pairs(sessions) do
    if M.session(id) then n = n + 1 end
  end
  return n
end

-- While a card's session runs here, its claim on a cloud board holds: the
-- Worker blocks a working card it hasn't heard about for 15 minutes, and a
-- session that sits idle calls the board seldom. Every 5, it's told.
local HEARTBEAT_MS = 5 * 60 * 1000
local heartbeat

local function beat()
  local cards = require("corkboard.cards")
  if not cards.cloud() then return end
  for id in pairs(sessions) do
    if M.session(id) then
      local found, card = pcall(board().get, id)
      if found and card.agent then cards.touch(id, card.agent) end
    end
  end
end

local function keep_alive()
  if heartbeat then return end
  heartbeat = assert(vim.uv.new_timer())
  heartbeat:start(HEARTBEAT_MS, HEARTBEAT_MS, vim.schedule_wrap(beat))
end

-- Make buf's session the one working on card id (nil: on none), as a
-- session started on the card is: its card in the panel beside it, s on the
-- board going to it, and its claim kept alive.
function M.link(buf, id)
  local was = vim.b[buf].corkboard_card
  if was and sessions[was] == buf then sessions[was] = nil end
  vim.b[buf].corkboard_card = id
  -- Not started on it, so corkboard.restore resumes it where it was and
  -- links it again, rather than as the card's agent in its worktree.
  vim.b[buf].corkboard_linked = id ~= nil or nil
  if id then
    sessions[id] = buf
    exited[id] = nil
    keep_alive()
  end
  board().push()
  -- The board's state may not have changed, but the panel's has.
  require("corkboard.claude.cards").push_all()
end

-- The card's worktree and branch, made from the main checkout's HEAD the
-- first time; a card sent back from review gets the same one again. Outside
-- a repository the agent works in the project itself (both nil).
function M.worktree(id)
  local root = util.repo_root(vim.fn.getcwd())
  if not root then return nil, nil end
  local dir = util.data_dir("worktrees", util.path_key(root), id:lower())
  local branch = "card/" .. id:lower()
  if vim.fn.isdirectory(dir) == 1 then return dir, branch end
  vim.fn.mkdir(vim.fs.dirname(dir), "p")
  local exists = util.git({ "rev-parse", "--verify", "--quiet", "refs/heads/" .. branch }, root)
  local args = exists and { "worktree", "add", dir, branch } or { "worktree", "add", "-b", branch, dir }
  local ok, _, err = util.git(args, root)
  if not ok then error("git worktree add: " .. err, 0) end
  return dir, branch
end

-- A cloud board's MCP server, with a token for this card's agent only. The
-- config holds the token, so it's a file only this user can read, not an
-- argument every process can see. Returns its path, and what undoes it.
local function cloud_mcp_config(id)
  local cards = require("corkboard.cards")
  local grant = cards.agent_token(id, "claude")
  local dir = vim.fs.joinpath(vim.fn.stdpath("state"), "corkboard", "agents")
  vim.fn.mkdir(dir, "p", tonumber("700", 8))
  local path = vim.fs.joinpath(dir, util.project_key() .. "-" .. id:lower() .. ".json")
  local config = { mcpServers = { corkboard = { type = "http", url = grant.url, headers = { Authorization = "Bearer " .. grant.token } } } }
  local fd = assert(vim.uv.fs_open(path, "w", tonumber("600", 8)))
  vim.uv.fs_write(fd, vim.json.encode(config))
  vim.uv.fs_close(fd)
  return path, function()
    vim.uv.fs_unlink(path)
    pcall(cards.revoke_agent_token, grant.token)
  end
end

-- The corkboard MCP for projects that don't configure it: the Worker's for a
-- cloud board, else this checkout's mcp/board.ts over the card files.
-- Returns the --mcp-config value, and what to do when the agent exits.
local function mcp_config(id)
  if require("corkboard.cards").cloud() then return cloud_mcp_config(id) end
  local here = vim.api.nvim_get_runtime_file("lua/corkboard/agents.lua", false)[1]
  local script = vim.fs.joinpath(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(here)))), "mcp", "board.ts")
  if vim.fn.filereadable(script) == 0 then return nil end
  return vim.json.encode({ mcpServers = { corkboard = { command = "bun", args = { script } } } })
end

-- sent_back: the user sent the card back from review and is at the session
-- to say what to change.
local function prompt(card, branch, sent_back)
  local where = branch and ("in a git worktree of your own, on branch " .. branch .. ". Commit your work on that branch.")
    or "in the project directory."
  return table.concat({
    string.format("You are working on corkboard card %s: %q, %s", card.id, card.title, where),
    string.format("Start by calling claim_card with id %s, and read the card.", card.id),
    sent_back and "The user sent this card back from review. After reading it, wait for them to tell you what to change."
      or "",
    "Log progress and decisions with log. If you need a decision from the user, ask it here with AskUserQuestion:"
      .. " corkboard tells them and brings them to this session to answer.",
    "When you are done, call submit_for_review with what changed and how you verified it.",
  }, "\n")
end

-- Start an agent on the card now, whatever the limit, or go to its session
-- if one is running. opts.sent_back: see prompt(); opts.resume: a session
-- to resume instead of starting one (corkboard.restore); opts.here: in the
-- current window, not a tab.
function M.start(id, opts)
  if M.session(id) then return terminal.focus(sessions[id]) end
  local card = board().get(id)
  local ok, dir, branch = pcall(M.worktree, id)
  if not ok then
    board().set(id, { agent_state = "blocked", attention = "could not make a worktree: " .. dir })
    return
  end
  -- --mcp-config takes any number of values, so -- ends the options before
  -- the prompt.
  local args = {}
  local made, config, cleanup = pcall(mcp_config, id)
  if not made then
    board().set(id, { agent_state = "blocked", attention = "could not give the agent the board: " .. config })
    return
  end
  if config then vim.list_extend(args, { "--mcp-config", config }) end
  vim.list_extend(args, { "--name", id .. " " .. card.title })
  vim.list_extend(args, vim.g.corkboard_agent_args or {})
  if opts and opts.resume then
    vim.list_extend(args, { "--resume", opts.resume })
  else
    vim.list_extend(args, { "--", prompt(card, branch, opts and opts.sent_back) })
  end

  local buf
  buf = require("corkboard.claude").start({
    kind = "card",
    args = args,
    here = opts and opts.here,
    cwd = dir,
    -- For the MCP server: who the agent is, and the board, which a worktree
    -- outside the repository couldn't find by itself.
    env = { CORKBOARD_AGENT = "claude", CORKBOARD_CARD = id, CORKBOARD_BOARD = board().dir() },
    on_exit = function()
      if cleanup then cleanup() end
      if sessions[id] == buf then
        sessions[id] = nil
        exited[id] = true
      end
      live[buf] = nil
      -- Gone before it claimed the card: say so rather than start it again
      -- and again.
      local found, now = pcall(board().get, id)
      if found and now.agent_state == "queued" then
        board().set(id, { agent_state = "blocked", attention = "the agent exited before it started; queue it again to retry" })
      else
        board().push()
      end
    end,
  })
  if not buf then
    if cleanup then cleanup() end
    return
  end
  vim.b[buf].corkboard_card = id
  sessions[id] = buf
  exited[id] = nil
  keep_alive()
  board().set(id, { agent = card.agent or "claude", worktree = dir or "", branch = branch or "" })
end

-- Start what is queued and may run, up to the limit. Only with the page
-- attached, so a Neovim nobody is looking at (a test, a script) starts nothing.
function M.schedule(cards)
  if not require("corkboard").attached() then return end
  local room = (vim.g.corkboard_max_agents or 3) - M.running() - vim.tbl_count(starting)
  for _, c in ipairs(cards) do
    if room <= 0 then return end
    if c.agent_state == "queued" and not M.session(c.id) and not starting[c.id] and not board().waiting_on(c) then
      room = room - 1
      starting[c.id] = true
      -- Not inside the board's push, which start() calls back into.
      vim.schedule(function()
        starting[c.id] = nil
        M.start(c.id)
      end)
    end
  end
end

return M
