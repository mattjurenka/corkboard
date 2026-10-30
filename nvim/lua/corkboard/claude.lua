-- Claude Code sessions in tabs of their own, wired back to corkboard through
-- hooks (nvim/hooks/): their PushNotifications reach the page's list, and
-- their events keep corkboard.agents' idea of what each session is doing.

local M = {}

local function hook(name)
  local script = vim.api.nvim_get_runtime_file("hooks/" .. name, false)[1]
  return {
    type = "command",
    command = table.concat({ vim.fn.shellescape(require("corkboard.util").progpath()), "--clean --headless -l", vim.fn.shellescape(script) }, " "),
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
-- without them), attach (a command that joins a session already running
-- elsewhere, run as it is: prompt and args don't apply), vm (the VM via or
-- attach reaches, for the fleet view), shell (a command for a shell where
-- the session runs, which <C-`> opens there). The tab closes with the session,
-- unless a shell in it is still running.
function M.start(opts)
  opts = opts or {}
  local exe = opts.attach and opts.attach[1] or opts.via and opts.via[1] or "claude"
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
  vim.b[buf].corkboard_vm = opts.vm
  vim.b[buf].corkboard_shell = opts.shell
  -- Its --name, for away mode's list (corkboard.away).
  local args = opts.args or {}
  for i, arg in ipairs(args) do
    if arg == "--" then break end
    if arg == "--name" then vim.b[buf].corkboard_name = args[i + 1] end
  end
  -- Elsewhere, its PushNotifications have no hook to bring them here.
  local parts = (opts.via or opts.attach) and {} or { NOTIFY_PROMPT }
  if opts.prompt then table.insert(parts, opts.prompt) end
  local prompt = table.concat(parts, "\n\n")
  local cmd
  if opts.attach then
    cmd = vim.deepcopy(opts.attach)
  elseif opts.via then
    cmd = vim.list_extend(vim.deepcopy(opts.via), { "claude", "--append-system-prompt", prompt })
  else
    cmd = { "claude", "--settings", vim.json.encode(settings()), "--append-system-prompt", prompt }
    -- The mod (claude-plugin/) that draws the transcript as corkboard's ledger,
    -- and Pepper's plan beside it.
    local mod = vim.api.nvim_get_runtime_file("claude-plugin/.claude-plugin/plugin.json", false)[1]
    if mod then vim.list_extend(cmd, { "--plugin-dir", vim.fs.dirname(vim.fs.dirname(mod)) }) end
  end
  vim.fn.jobstart(opts.attach and cmd or vim.list_extend(cmd, opts.args or {}), {
    term = true,
    cwd = opts.cwd,
    -- Its colors, for the phone.
    on_stdout = require("corkboard.vt").track(buf),
    -- CORKBOARD_BUF tells the hooks which terminal the session is in;
    -- CORKBOARD_LIVE and CORKBOARD_SESSION, the mod what to draw.
    env = vim.tbl_extend("force", opts.env or {}, {
      CORKBOARD_BUF = tostring(buf),
      CORKBOARD_LIVE = require("corkboard.live").path(),
      CORKBOARD_SESSION = opts.kind or "project",
    }),
  })
  -- Elsewhere, no hook says it started.
  if opts.via or opts.attach then vim.schedule(require("corkboard.away").report) end
  vim.api.nvim_create_autocmd("TermClose", {
    buffer = buf,
    once = true,
    callback = function()
      local status = vim.b[buf].corkboard_exit_status or vim.v.event.status
      require("corkboard.vt").forget(buf)
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

-- What to call a session: its --name, else what Claude Code puts in the
-- terminal's title (without its spinner), else Claude Code.
function M.title(buf)
  local t = (vim.b[buf].term_title or ""):gsub("^[^%w]+", "")
  return vim.b[buf].corkboard_name or (t ~= "" and t) or "Claude Code"
end

-- A fleet session, once it's running: its conversation, in a tab of its
-- own. fleetd has the spawn claimed and started within a minute or so; its
-- session shows among the bridges' when it has.
local function follow_spawn(spawn, label)
  local cloud = require("corkboard.cards.cloud")
  local ui = require("corkboard")
  local tries = 0
  local function look()
    tries = tries + 1
    local ok, fleet = pcall(cloud.call, "fleet_get")
    local s = ok and vim.iter(fleet.spawns or {}):find(function(x) return x.id == spawn.id end)
    if s and (s.state == "failed" or s.state == "stopped" or s.state == "done") then
      return ui.toast("session-" .. spawn.id, "error", label .. ": " .. s.state .. (s.error ~= vim.NIL and s.error and (" (" .. s.error .. ")") or ""))
    end
    local slot = s and s.slot ~= vim.NIL and s.slot or nil
    for _, b in ipairs(ok and fleet.bridges or {}) do
      for _, c in ipairs(b.sessions or {}) do
        if slot and c.vm == slot and b.environment == spawn.environment and c.attach then
          ui.toast("session-" .. spawn.id, "done", label .. " is running in " .. slot)
          return require("corkboard.conversation").open(b.id, c.key, c.name or label)
        end
      end
    end
    if tries >= 60 then return ui.toast("session-" .. spawn.id, "error", label .. " hasn't started after 3 minutes; the fleet view has it") end
    vim.defer_fn(look, 3000)
  end
  vim.defer_fn(look, 3000)
end

-- <C-.>: a Claude Code session, wherever you choose: here, when this
-- machine has claude, or in one of the fleet's VMs (an environment's agent
-- template, on this board's project), whose conversation opens when it's up.
function M.open()
  local cloud = require("corkboard.cards.cloud")
  local choices = {}
  if vim.fn.executable("claude") == 1 then table.insert(choices, { text = "Claude Code here", run = function() M.start() end }) end
  local ok, fleet = pcall(cloud.call, "fleet_get")
  for _, e in ipairs(ok and fleet.environments or {}) do
    local slots = vim.tbl_get(e, "running", "slots") or {}
    local free = #vim.tbl_filter(function(sl) return sl.spawn == vim.NIL or sl.spawn == nil end, slots)
    local names = vim.tbl_keys(e.templates or {})
    table.sort(names)
    for _, t in ipairs(names) do
      local caps = e.templates[t].capNames
      table.insert(choices, {
        text = string.format("%s in %s", t, e.name),
        detail = string.format("%d of %d VMs free%s", free, #slots, type(caps) == "table" and #caps > 0 and (" · " .. table.concat(caps, ", ")) or ""),
        run = function()
          local label = t .. " in " .. e.name
          local id = "session-" .. e.name .. "-" .. t
          require("corkboard").toast(id, "pending", "starting " .. label)
          local queued, spawn = pcall(cloud.call, "fleet_session", e.name, t, cloud.key())
          if not queued then return require("corkboard").toast(id, "error", "couldn't start " .. label .. ": " .. tostring(spawn)) end
          require("corkboard").toast(id, "done", label .. " queued")
          follow_spawn(spawn, label)
        end,
      })
    end
  end
  if #choices == 0 then
    return vim.notify("corkboard: no claude here, and no fleet to start a session in" .. (ok and "" or (": " .. tostring(fleet))), vim.log.levels.ERROR)
  end
  vim.ui.select(choices, {
    prompt = "Claude Code session",
    format_item = function(c) return c.detail and (c.text .. "  (" .. c.detail .. ")") or c.text end,
  }, function(c)
    if c then c.run() end
  end)
end

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
