-- Agents on cards. Handing a card to an agent (the board's a) queues it;
-- whenever the board changes, queued cards whose dependencies are done are
-- started, up to g:corkboard_max_agents at once (3 unset). Starting one
-- gives it a git worktree of its own on branch card/task-<n> (see
-- worktree()), and interactive Claude Code in a tab, told to work on the
-- card through the corkboard MCP. The card records the worktree and
-- branch; the terminal is the card's session while it runs.
--
-- Sessions live in this Neovim: they end when it does (the bridge stops it
-- when the page's window closes), and a card still queued then starts
-- again the next time the board is open.

local M = {}

local function board() return require("corkboard.board") end

-- card id -> terminal buffer, for sessions still running; and cards
-- schedule() has set going that start() hasn't reached yet. live and
-- exited (below) go with sessions.
local sessions = {}
local starting = {}
local live = {}
local exited = {}

local function alive(buf)
  return buf and vim.api.nvim_buf_is_valid(buf) and vim.fn.jobwait({ vim.bo[buf].channel }, 0)[1] == -1
end

-- The card's running session's terminal, if it has one.
function M.session(id)
  if alive(sessions[id]) then return sessions[id] end
  -- Its job can end before its TermClose (on_exit in start()) runs.
  if sessions[id] then exited[id] = true end
  sessions[id] = nil
end

-- What each session is doing, by terminal buffer, from its hooks
-- (hooks/claude-session.lua): working, idle, or permission (waiting on a
-- permission prompt). And the cards whose session has exited.

-- The card's session state for the board: live's, "exited", or nil when
-- it has had no session in this Neovim.
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
    if kind == "idle_prompt" then return "idle" end
    return nil
  end
  return ({
    SessionStart = "idle",
    UserPromptSubmit = "working",
    PreToolUse = "working",
    PostToolUse = "working",
    PermissionRequest = "permission",
    Stop = "idle",
  })[ev.event]
end

-- Each card's Claude Code sessions, kept beside the board in
-- sessions.json as { [card id] = { { id, transcript, started }, ... } }, so their
-- usage can be added up per card (corkboard.usage) after they end.
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

-- Go to what the card's agent wants: its session, where the question or
-- permission prompt is Claude Code's own, to answer there; the card when
-- no session runs. Going is also letting it past a budget
-- (corkboard.budget). What the page's notification for the card does.
function M.attend(id)
  board().set(id, { attention = "", budget_hold = "" })
  local buf = M.session(id)
  if buf then return require("corkboard.picker").focus_terminal(buf) end
  board().show()
  board().select(id)
  board().open_card(id)
end

-- The card asks while its session waits on the user: an AskUserQuestion
-- or a permission prompt. Setting attention raises the page's notification
-- (attention.ts); the session's next step clears it.
local function asking(id, ev)
  if ev.event == "PreToolUse" and ev.tool_name == "AskUserQuestion" then
    return "asks: " .. (ev.question or "a question")
  elseif ev.event == "PermissionRequest" then
    return "wants permission" .. (ev.tool_name and (" for " .. ev.tool_name) or "")
  end
end

-- From a session's hook.
function M.hook(ev)
  local buf = ev.buf
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local id = vim.b[buf].corkboard_card
  if ev.event == "SessionStart" and id and ev.session_id then remember(id, ev.session_id, ev.transcript_path) end
  local was = live[buf]
  local state = event_state(ev)
  if state then live[buf] = state end
  if not id then return end
  local question = asking(id, ev)
  if question then
    board().set(id, { agent_state = "blocked", attention = question })
  elseif (was == "asking" or was == "permission") and state and state ~= "asking" and state ~= "permission" then
    -- Answered (or refused), in the session.
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

local function git(args, cwd)
  local result = vim.system(vim.list_extend({ "git" }, args), { cwd = cwd, text = true }):wait()
  return result.code == 0, vim.trim(result.stdout or ""), vim.trim(result.stderr or "")
end

-- The main checkout of the project's repository, from any worktree; nil
-- outside one.
local function repo()
  local ok, common = git({ "rev-parse", "--path-format=absolute", "--git-common-dir" }, vim.fn.getcwd())
  return ok and vim.fs.dirname(common) or nil
end

local worktrees = vim.fs.joinpath(
  vim.env.XDG_DATA_HOME or vim.fs.joinpath(vim.uv.os_homedir(), ".local/share"),
  "corkboard",
  "worktrees"
)

-- The card's worktree and branch, made from the main checkout's HEAD the
-- first time; a card sent back from review gets the same one again.
-- Outside a repository the agent works in the project itself (both nil).
function M.worktree(id)
  local root = repo()
  if not root then return nil, nil end
  local dir = vim.fs.joinpath(worktrees, (root:gsub("^/", ""):gsub("/", "-")), id:lower())
  local branch = "card/" .. id:lower()
  if vim.fn.isdirectory(dir) == 1 then return dir, branch end
  vim.fn.mkdir(vim.fs.dirname(dir), "p")
  local exists = git({ "rev-parse", "--verify", "--quiet", "refs/heads/" .. branch }, root)
  local args = exists and { "worktree", "add", dir, branch } or { "worktree", "add", "-b", branch, dir }
  local ok, _, err = git(args, root)
  if not ok then error("git worktree add: " .. err, 0) end
  return dir, branch
end

-- The corkboard MCP, from this checkout of corkboard, for projects that
-- don't configure it themselves.
local function mcp_config()
  local here = vim.api.nvim_get_runtime_file("lua/corkboard/agents.lua", false)[1]
  local script = vim.fs.joinpath(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(here)))), "mcp", "board.ts")
  if vim.fn.filereadable(script) == 0 then return nil end
  return vim.json.encode({ mcpServers = { corkboard = { command = "bun", args = { script } } } })
end

-- sent_back: the user sent the card back from review and is at this
-- session to say what to change.
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

-- Start an agent on the card now, whatever the limit (opts.sent_back: see
-- prompt()); with a session
-- running already, go to it.
function M.start(id, opts)
  if M.session(id) then return require("corkboard.picker").focus_terminal(sessions[id]) end
  local card = board().get(id)
  local ok, dir, branch = pcall(M.worktree, id)
  if not ok then
    board().set(id, { agent_state = "blocked", attention = "could not make a worktree: " .. dir })
    return
  end
  -- --mcp-config takes any number of values, so something else follows
  -- it, and -- ends the options before the prompt.
  local args = {}
  local config = mcp_config()
  if config then vim.list_extend(args, { "--mcp-config", config }) end
  vim.list_extend(args, { "--name", id .. " " .. card.title })
  vim.list_extend(args, vim.g.corkboard_agent_args or {})
  vim.list_extend(args, { "--", prompt(card, branch, opts and opts.sent_back) })

  local buf
  buf = require("corkboard.picker").start_claude({
    args = args,
    cwd = dir,
    -- The MCP server inherits these: who the agent is, and the board,
    -- which a worktree outside the repository couldn't find by itself.
    env = { CORKBOARD_AGENT = "claude", CORKBOARD_CARD = id, CORKBOARD_BOARD = board().dir() },
    on_exit = function()
      if sessions[id] == buf then
        sessions[id] = nil
        exited[id] = true
      end
      live[buf] = nil
      -- Gone before it claimed the card: say so, rather than start it
      -- again and again.
      local ok_get, now = pcall(board().get, id)
      if ok_get and now.agent_state == "queued" then
        board().set(id, { agent_state = "blocked", attention = "the agent exited before it started; queue it again to retry" })
      else
        board().push()
      end
    end,
  })
  if not buf then return end
  vim.b[buf].corkboard_card = id
  sessions[id] = buf
  exited[id] = nil
  board().set(id, { agent = card.agent or "claude", worktree = dir or "", branch = branch or "" })
end

-- Start what is queued and may run, up to the limit. Only with the page
-- attached, so that a Neovim nobody is looking at (a test, a script)
-- starts nothing.
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
