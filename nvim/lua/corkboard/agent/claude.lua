-- Claude Code as a corkboard agent kind (corkboard.agent): its own TUI in a
-- terminal, wired back to corkboard through hooks (nvim/hooks/): its
-- PushNotifications reach the page's list, and its events keep
-- corkboard.agents' idea of what each session is doing.

local M = {
  name = "claude",
  label = "Claude Code",
  exe = "claude",
  events = "hooks",
}

-- The Claude account this machine is logged in as, which a session started
-- here runs as when its brain names none; nil if it can't be told.
local function login()
  local config = vim.env.CLAUDE_CONFIG_DIR or vim.uv.os_homedir()
  local ok, lines = pcall(vim.fn.readfile, vim.fs.joinpath(config, ".claude.json"))
  local parsed, json = ok, nil
  if ok then parsed, json = pcall(vim.json.decode, table.concat(lines, "\n")) end
  local account = parsed and type(json) == "table" and json.oauthAccount
  local email = type(account) == "table" and account.emailAddress
  return type(email) == "string" and email or nil
end

-- The account a session started here for brain (the default one for nil)
-- runs as, and that account's token for Claude Code: the one fleetd hands
-- that brain's VMs (fleet/fleetd/fleet.ts's ACCOUNTS, from `claude
-- setup-token`). No token: the machine's login, said if the brain wanted
-- another.
local function account_for(brain)
  local account, known = require("corkboard.brains").account_now(brain)
  if not account then
    if not known then vim.notify("corkboard: the brains aren't in, so this session runs as this machine's account", vim.log.levels.WARN) end
    return login(), nil
  end
  local state = vim.env.CORKBOARD_FLEET_STATE or vim.fs.joinpath(vim.uv.os_homedir(), ".local/state/corkboard/fleet")
  local ok, lines = pcall(vim.fn.readfile, vim.fs.joinpath(state, "accounts", account))
  local token = ok and account:match("^[%w._-]+$") and vim.trim(lines[1] or "") or ""
  if token == "" then
    vim.notify("corkboard: no token for the " .. account .. " account on this machine, so this session runs as its own", vim.log.levels.WARN)
    return login(), nil
  end
  return account, token
end

-- One word for the shell Claude Code runs hooks with, whatever 'shell' is
-- here (shellescape follows it): sh on unix; on Windows, Git Bash or cmd,
-- which both take a "-quoted path with / for \.
local function word(s)
  if vim.fn.has("win32") == 1 then return '"' .. s:gsub("\\", "/") .. '"' end
  return "'" .. s:gsub("'", [['\'']]) .. "'"
end

local function hook(name)
  local script = vim.api.nvim_get_runtime_file("hooks/" .. name, false)[1]
  return {
    type = "command",
    command = table.concat({ word(require("corkboard.util").progpath()), "--clean --headless -l", word(script) }, " "),
  }
end

-- Added to the user's own settings; the mod's say (claude-plugin/hooks/say.tsx)
-- needs no asking.
local function settings()
  local session = { hooks = { hook("session.lua") } }
  -- The brain's memory, from the node (hooks/claude-memory.lua).
  local memory = { hooks = { hook("claude-memory.lua") } }
  return {
    permissions = { allow = { "mcp__corkboard-ui__say", "mcp__corkboard-ui__emote" } },
    hooks = {
      PostToolUse = {
        { matcher = "PushNotification", hooks = { hook("claude-notification.lua") } },
        session,
      },
      SessionStart = { session, memory },
      PreCompact = { memory },
      SessionEnd = { memory },
      UserPromptSubmit = { session },
      PreToolUse = { session },
      PermissionRequest = { session },
      Notification = { session },
      Stop = { session },
    },
  }
end

-- Claude Code can't tell whether you are looking at a terminal inside this
-- page, so the notification hook passes every PushNotification on and the
-- page decides. Sessions are asked to send them freely.
local NOTIFY_PROMPT = table.concat({
  "You are running inside corkboard, which forwards PushNotification calls to the user's desktop when they are not looking at it.",
  "Call PushNotification whenever you need the user to decide, approve or do something, and when you finish a task that took more than a minute or two.",
  "Send it even if you think the user is watching; a \"not sent\" result is expected and still reaches them.",
  "Whenever you have something for the user to look at (a screenshot, image, plot, recording, PDF), show it in the media panel beside you with mcp__corkboard-ui__show rather than giving its path or describing it.",
}, " ")

-- What a session is started with, after corkboard's own options. --mcp-config
-- takes any number of values, so -- ends the options before the task.
local function args(o)
  local out = {}
  if o.mcp then vim.list_extend(out, { "--mcp-config", o.mcp }) end
  if o.name then vim.list_extend(out, { "--name", o.name }) end
  vim.list_extend(out, o.args or {})
  if o.resume then
    vim.list_extend(out, { "--resume", o.resume })
  elseif o.task then
    vim.list_extend(out, { "--", o.task })
  end
  return out
end

-- The command that runs a session, its environment, and the account it runs
-- as. o: prompt (added to the system prompt after corkboard's), brain, mcp
-- (an --mcp-config value: a file or JSON), name, task (its first prompt),
-- resume (a session id), args (more of claude's own), via (a command that
-- runs claude somewhere else: corkboard's hooks and mod are files on this
-- machine, so that session goes without them), attach (a command that joins
-- a session already running elsewhere, run as it is).
function M.command(o)
  if o.attach then return vim.deepcopy(o.attach), {}, nil end
  -- Elsewhere, its PushNotifications have no hook to bring them here.
  local parts = o.via and {} or { NOTIFY_PROMPT }
  if o.prompt then table.insert(parts, o.prompt) end
  local prompt = table.concat(parts, "\n\n")
  if o.via then
    return vim.list_extend(vim.deepcopy(o.via), vim.list_extend({ "claude", "--append-system-prompt", prompt }, args(o))), {}, nil
  end
  local account, token = account_for(o.brain)
  local cmd = { "claude", "--settings", vim.json.encode(settings()), "--append-system-prompt", prompt }
  -- The memory tools, from the bridge's node (bridge/node/app.ts); with =,
  -- since --mcp-config otherwise takes as many values as follow it.
  if vim.env.CORKBOARD_MEMORY_MCP_CONFIG then table.insert(cmd, 2, "--mcp-config=" .. vim.env.CORKBOARD_MEMORY_MCP_CONFIG) end
  -- The mod (claude-plugin/) that draws the transcript as corkboard's ledger,
  -- and Pepper's plan beside it.
  local mod = vim.api.nvim_get_runtime_file("claude-plugin/.claude-plugin/plugin.json", false)[1]
  if mod then vim.list_extend(cmd, { "--plugin-dir", vim.fs.dirname(vim.fs.dirname(mod)) }) end
  -- CLAUDE_CODE_OAUTH_TOKEN: the account to run as.
  return vim.list_extend(cmd, args(o)), { CLAUDE_CODE_OAUTH_TOKEN = token }, account
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

-- What its transcript says: context, the last request's input tokens
-- (corkboard.context); background, the tool calls whose background work
-- has come back.
M.read = {
  context = function(path) return require("corkboard.context").last(path) end,
  background = finished_tasks,
}

return M
