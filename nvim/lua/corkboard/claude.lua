-- Claude Code sessions in tabs of their own, wired back to corkboard through
-- hooks (nvim/hooks/): their PushNotifications reach the page's list, and
-- their events keep corkboard.agents' idea of what each session is doing.

local M = {}

local function hook(name)
  local script = vim.api.nvim_get_runtime_file("hooks/" .. name, false)[1]
  return {
    type = "command",
    command = table.concat({ vim.fn.shellescape(vim.v.progpath), "--clean --headless -l", vim.fn.shellescape(script) }, " "),
  }
end

-- Added to the user's own settings.
local function settings()
  local session = { hooks = { hook("claude-session.lua") } }
  return {
    hooks = {
      PostToolUse = {
        { matcher = "PushNotification", hooks = { hook("claude-notification.lua") } },
        session,
      },
      SessionStart = { session },
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
}, " ")

-- Start Claude Code in a new tab; returns its terminal buffer, or nil when
-- claude is not on PATH. opts: args (after corkboard's own), cwd, env,
-- kind (what the mod draws: "pepper", "card", or "project" by default),
-- on_exit(status), prompt (added to the system prompt after corkboard's),
-- here (in the current window instead of a tab), split (in a window to the
-- right of the current one), via
-- (a command that runs claude somewhere else, like { "pepper-vm-ssh" }:
-- corkboard's hooks and mod are files on this machine, so that session goes
-- without them). The tab closes with the session, unless a shell in it is
-- still running.
function M.start(opts)
  opts = opts or {}
  local exe = opts.via and opts.via[1] or "claude"
  if vim.fn.executable(exe) == 0 then
    vim.notify("corkboard: " .. exe .. " is not on PATH", vim.log.levels.ERROR)
    return nil
  end
  if opts.here then
    vim.cmd.enew()
  elseif opts.split then
    vim.cmd("rightbelow vnew")
  else
    vim.cmd.tabnew()
  end
  local buf = vim.api.nvim_get_current_buf()
  local tab = vim.api.nvim_get_current_tabpage()
  -- What it is, for corkboard.claude.cards, which opens beside it.
  vim.b[buf].corkboard_claude = opts.kind or "project"
  -- Its --name, for away mode's list (corkboard.away).
  local args = opts.args or {}
  for i, arg in ipairs(args) do
    if arg == "--" then break end
    if arg == "--name" then vim.b[buf].corkboard_name = args[i + 1] end
  end
  -- Elsewhere, its PushNotifications have no hook to bring them here.
  local parts = opts.via and {} or { NOTIFY_PROMPT }
  if opts.prompt then table.insert(parts, opts.prompt) end
  local prompt = table.concat(parts, "\n\n")
  local cmd
  if opts.via then
    cmd = vim.list_extend(vim.deepcopy(opts.via), { "claude", "--append-system-prompt", prompt })
  else
    cmd = { "claude", "--settings", vim.json.encode(settings()), "--append-system-prompt", prompt }
    -- The mod (claude-plugin/) that draws the transcript as corkboard's ledger,
    -- and Pepper's plan beside it.
    local mod = vim.api.nvim_get_runtime_file("claude-plugin/.claude-plugin/plugin.json", false)[1]
    if mod then vim.list_extend(cmd, { "--plugin-dir", vim.fs.dirname(vim.fs.dirname(mod)) }) end
  end
  vim.fn.jobstart(vim.list_extend(cmd, opts.args or {}), {
    term = true,
    cwd = opts.cwd,
    -- CORKBOARD_BUF tells the hooks which terminal the session is in;
    -- CORKBOARD_LIVE and CORKBOARD_SESSION, the mod what to draw.
    env = vim.tbl_extend("force", opts.env or {}, {
      CORKBOARD_BUF = tostring(buf),
      CORKBOARD_LIVE = require("corkboard.live").path(),
      CORKBOARD_SESSION = opts.kind or "project",
    }),
  })
  vim.api.nvim_create_autocmd("TermClose", {
    buffer = buf,
    once = true,
    callback = function()
      local status = vim.v.event.status
      vim.schedule(function()
        if opts.on_exit then opts.on_exit(status) end
        require("corkboard.away").report()
        if vim.api.nvim_tabpage_is_valid(tab) and require("corkboard.terminal").alive(vim.t[tab].corkboard_terminal) then return end
        -- The buffer and its output go with the tab, so say why.
        if status ~= 0 then vim.notify("corkboard: claude exited with status " .. status, vim.log.levels.WARN) end
        pcall(vim.api.nvim_buf_delete, buf, { force = true })
      end)
    end,
  })
  return buf
end

-- <C-.>: Claude Code in the project.
function M.open() M.start() end

local HANDOFF_PROMPT = [=[
Pepper, Matt's personal assistant, handed you this work from the day plan window. Do it here, in this project.
If it is unclear or needs a decision, ask Matt here with AskUserQuestion.]=]

-- The project a hand-off names: a directory, or the name of a recent
-- project's folder; this Neovim's own when it names none.
local function project_dir(project)
  if not project or project == "" then return vim.fn.getcwd(-1, -1) end
  local dir = vim.fs.normalize(project)
  if vim.fn.isdirectory(dir) == 1 then return dir end
  local recent = require("corkboard").recent_projects()
  for _, d in ipairs(recent) do
    if vim.fs.basename(d) == project then return d end
  end
  return nil, string.format("no project %q; recent projects: %s", project, table.concat(recent, ", "))
end

-- Pepper's hand_off (hooks/handoff.lua, from the mod): a Claude Code tab in
-- the project, started on the task. req: task, project, name. Returns
-- whether it started, and what to tell Pepper.
function M.handoff(req)
  local corkboard = require("corkboard")
  if corkboard.window == "plan" or not corkboard.attached() then return false, "this Neovim has no page" end
  if type(req) ~= "table" or type(req.task) ~= "string" or req.task == "" then return false, "no task" end
  local dir, err = project_dir(req.project)
  if not dir then return false, err end
  local name = type(req.name) == "string" and req.name ~= "" and req.name or nil
  local args = name and { "--name", name } or {}
  vim.list_extend(args, { "--", req.task })
  if not M.start({ cwd = dir, prompt = HANDOFF_PROMPT, args = args }) then return false, "claude is not on PATH" end
  return true, string.format("started Claude Code in %s%s", vim.fn.fnamemodify(dir, ":~"), name and (", tab " .. name) or "")
end

return M
