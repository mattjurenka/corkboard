-- Claude Code in the day plan's window: a terminal beside the plan, logged
-- in to one account (corkboard.plan_account) whatever ~/.claude is logged in
-- to. It has a Claude Code config directory of its own (CLAUDE_CONFIG_DIR),
-- so its login is its own: /login there once, and logging in or out
-- elsewhere doesn't change it. The rest of ~/.claude (settings, CLAUDE.md,
-- skills, agents, commands, plugins) is linked in, so it's the same Claude
-- otherwise.
--
-- It plans with corkboard's MCP server (plan_read, plan_propose, notes), and
-- proposes rather than writing the calendar: the user accepts in the plan,
-- which writes it (corkboard.plan's accept).

local M = {}

local SHARED = { "settings.json", "CLAUDE.md", "skills", "agents", "commands", "plugins", "keybindings.json" }

local function state_dir()
  return vim.fs.joinpath(vim.env.XDG_STATE_HOME or vim.fs.joinpath(vim.uv.os_homedir(), ".local/state"), "corkboard", "claude-personal")
end

-- The config directory, made the first time, with ~/.claude's shared parts
-- linked in. Links are made only where nothing is yet, so a file of its own
-- there is never replaced.
local function config_dir()
  local dir = state_dir()
  vim.fn.mkdir(dir, "p", tonumber("700", 8))
  local home = vim.env.CLAUDE_HOME_CONFIG or vim.fs.joinpath(vim.uv.os_homedir(), ".claude")
  for _, name in ipairs(SHARED) do
    local from, to = vim.fs.joinpath(home, name), vim.fs.joinpath(dir, name)
    if vim.uv.fs_stat(from) and not vim.uv.fs_lstat(to) then vim.uv.fs_symlink(from, to) end
  end
  return dir
end

-- The account its config directory is logged in to, or nil.
function M.account()
  local f = io.open(vim.fs.joinpath(state_dir(), ".claude.json"), "r")
  if not f then return nil end
  local ok, config = pcall(vim.json.decode, f:read("a"))
  f:close()
  local account = ok and type(config) == "table" and config.oauthAccount
  return type(account) == "table" and account.emailAddress or nil
end

local PROMPT = [[
You are the Claude Code session in corkboard's day plan window, beside the user's plan for today.
When the user asks you to plan or re-plan the day, follow the plan-my-day skill, with one change at its end:
instead of writing the Claude calendar (dayplan apply, or the calendar connector), call corkboard's plan_propose
with the blocks. The user sees it in the plan beside you as a diff, undoes what they don't want, and accepts with A,
which writes the calendar and opens the gate; they may also say what to change, which plan_read returns as asked.
Read today's plan with plan_read first; keep the ids of blocks you don't change. Minutes since midnight.
Use corkboard's notes (notes_search, note_read, note_append) for goals and what happened on earlier days.]]

local buf

function M.alive() return require("corkboard.terminal").alive(buf) end

-- Open it to the right of the plan, or go to it if it's open.
function M.open()
  if M.alive() then
    local win = vim.fn.win_findbuf(buf)[1]
    if win then return vim.api.nvim_set_current_win(win) end
    vim.cmd("rightbelow vsplit")
    vim.api.nvim_win_set_buf(0, buf)
    return
  end
  local want = require("corkboard").plan_account
  local have = M.account()
  if have and want and have:lower() ~= want:lower() then
    vim.notify(
      string.format("corkboard: the day plan's Claude is logged in as %s, not %s; /logout there, then /login", have, want),
      vim.log.levels.WARN
    )
  end
  local cloud = (vim.env.CORKBOARD_CLOUD or "https://corkboard.matthewjurenka.workers.dev"):gsub("/$", "")
  local mcp = vim.json.encode({ mcpServers = { corkboard = { type = "http", url = cloud .. "/mcp" } } })
  buf = require("corkboard.claude").start({
    split = true,
    cwd = vim.uv.os_homedir(),
    env = { CLAUDE_CONFIG_DIR = config_dir() },
    prompt = PROMPT,
    args = { "--mcp-config", mcp, "--name", "Day plan" },
  })
  if not buf then return end
  vim.b[buf].corkboard_plan_claude = true
  if not have then
    vim.notify("corkboard: log the day plan's Claude in once with /login, as " .. (want or "your account") .. "; then /mcp to sign in to corkboard")
  end
end

return M
