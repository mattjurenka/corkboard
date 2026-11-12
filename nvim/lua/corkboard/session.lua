-- Agent sessions in tabs of their own: the terminal, its tab and what ends
-- with it, whatever kind of agent runs in it (corkboard.agent says how
-- each is started and how its state comes back).

local M = {}

-- The file a click in a terminal landed on, resolved against dir, with the
-- line after it (path:12, path:12:3), or nil when the word
-- there names no file.
local function file_at(buf, dir, pos)
  local text = vim.api.nvim_buf_get_lines(buf, pos.line - 1, pos.line, false)[1]
  if not text or pos.column > #text then return end
  -- The run of path characters around the click.
  local s, e = pos.column, pos.column
  local function part(i) return text:sub(i, i):match("[%w%._%-/~:@+]") end
  if not part(s) then return end
  while s > 1 and part(s - 1) do s = s - 1 end
  while e < #text and part(e + 1) do e = e + 1 end
  local word = text:sub(s, e):gsub("[.:]+$", "")
  local path, line = word:match("^(.-):(%d+)")
  path = path or word
  if path:match("^%a[%w+.-]*://") then return end
  path = vim.fs.normalize(path)
  if not path:match("^/") then path = vim.fs.joinpath(type(dir) == "function" and dir() or dir, path) end
  if vim.fn.filereadable(path) == 0 then return end
  return path, tonumber(line)
end

-- A click on a file's path in a terminal (web/src/App.tsx, ./x.lua:12)
-- opens it as the file explorer would, in its preview tab, at that line. A
-- press and release on the same cell is a click; anything else, and every
-- press and release, still goes on to the terminal or Neovim as it was.
-- dir: what relative paths are from, or a function giving it at the click.
function M.open_on_click(buf, dir)
  local down
  local function pass(key)
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(key, true, false, true), "n", false)
  end
  vim.keymap.set({ "t", "n" }, "<LeftMouse>", function()
    down = vim.fn.getmousepos()
    pass("<LeftMouse>")
  end, { buffer = buf })
  vim.keymap.set({ "t", "n" }, "<LeftRelease>", function()
    local up, was = vim.fn.getmousepos(), down
    down = nil
    pass("<LeftRelease>")
    if not (was and up.winid == was.winid and up.line == was.line and up.column == was.column) then return end
    if up.winid == 0 or vim.api.nvim_win_get_buf(up.winid) ~= buf then return end
    local path, line = file_at(buf, dir, up)
    if not path then return end
    require("corkboard").open_file(path, true)
    if line then
      vim.schedule(function() pcall(vim.api.nvim_win_set_cursor, 0, { line, 0 }) end)
    end
  end, { buffer = buf })
end

-- Start an agent in a new tab; returns its terminal buffer, or nil when it
-- is not on PATH. opts: agent (its kind, corkboard.agent; the default
-- one's for nil), name, task (its first prompt), resume (a session of its to
-- go on with), mcp (the corkboard MCP's config for it), args (more of its
-- own, after corkboard's), cwd, env, role (what the mod draws: "pepper",
-- "card", or "project" by default), on_exit(status), prompt (added to the
-- system prompt after corkboard's), here (in the current window instead of
-- a tab), split (in a window to the right of the current one), via (a
-- command that runs it somewhere else, like { "pepper-vm-ssh" }:
-- corkboard's hooks and mod are files on this machine, so that session goes
-- without them), attach (a command that joins a session already running
-- elsewhere, run as it is: prompt, task and args don't apply), vm (the VM
-- via or attach reaches, for the fleet view and its status line), brain
-- (the brain it runs as, for its status line; one started here runs as that
-- brain's account), account (the account a VM's runs as, if not its
-- brain's), host and dir (the machine that VM is on and the directory in
-- it, for its status line), shell (a command for a shell where the session
-- runs, which <C-`> opens there). The tab closes with the session, unless a
-- shell in it is still running.
function M.start(opts)
  if require("corkboard.projects").need() then return end
  opts = opts or {}
  local kind, why = require("corkboard.agent").get(opts.agent)
  if not kind then
    vim.notify("corkboard: " .. why, vim.log.levels.ERROR)
    return nil
  end
  local exe = opts.attach and opts.attach[1] or opts.via and opts.via[1] or kind.exe
  if vim.fn.executable(exe) == 0 then
    vim.notify("corkboard: " .. exe .. " is not on PATH", vim.log.levels.ERROR)
    return nil
  end
  local cmd, kind_env, account = kind.command(opts)
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
  vim.b[buf].corkboard_agent = kind.name
  vim.b[buf].corkboard_role = opts.role or "project"
  vim.b[buf].corkboard_vm = opts.vm
  vim.b[buf].corkboard_brain = opts.brain
  vim.b[buf].corkboard_account = opts.account or account
  vim.b[buf].corkboard_host = opts.host
  vim.b[buf].corkboard_dir = opts.dir
  vim.b[buf].corkboard_shell = opts.shell
  -- For away mode's list (corkboard.away).
  vim.b[buf].corkboard_name = opts.name
  vim.fn.jobstart(cmd, {
    term = true,
    cwd = opts.cwd,
    -- Its colors, for the phone; its bytes, for its mirrors.
    on_stdout = (function()
      local track = require("corkboard.vt").track(buf)
      return function(chan, data, name)
        track(chan, data, name)
        require("corkboard.mirror").output(buf, data)
      end
    end)(),
    -- CORKBOARD_BUF tells the hooks which terminal the session is in, and
    -- CORKBOARD_CONTEXT_LIMIT when to hand off;
    -- CORKBOARD_LIVE and CORKBOARD_SESSION, the mod what to draw;
    -- CORKBOARD_MEMORY_BRAIN, the memory hook whose memory it is.
    env = vim.tbl_extend("force", opts.env or {}, kind_env, {
      CORKBOARD_BUF = tostring(buf),
      CORKBOARD_CONTEXT_LIMIT = tostring(require("corkboard.context").limit()),
      CORKBOARD_LIVE = require("corkboard.live").path(),
      CORKBOARD_SESSION = opts.role or "project",
      CORKBOARD_MEMORY_BRAIN = opts.brain,
    }),
  })
  -- Elsewhere, no hook says it started, and its files aren't here to open.
  if opts.via or opts.attach then
    vim.schedule(require("corkboard.away").report)
  else
    M.open_on_click(buf, vim.fs.normalize(opts.cwd or vim.fn.getcwd()))
  end
  vim.api.nvim_create_autocmd("TermClose", {
    buffer = buf,
    once = true,
    callback = function()
      local status = vim.b[buf].corkboard_exit_status or vim.v.event.status
      require("corkboard.vt").forget(buf)
      require("corkboard.mirror").ended(buf)
      vim.schedule(function()
        if opts.on_exit then opts.on_exit(status) end
        require("corkboard.away").report()
        if vim.api.nvim_tabpage_is_valid(tab) and require("corkboard.terminal").alive(vim.t[tab].corkboard_terminal) then return end
        -- The buffer and its output go with the tab, so say why.
        if status ~= 0 then vim.notify("corkboard: " .. kind.exe .. " exited with status " .. status, vim.log.levels.WARN) end
        pcall(vim.api.nvim_buf_delete, buf, { force = true })
      end)
    end,
  })
  return buf
end

-- What to call a session: its name, else what it was handed off as, else
-- what the agent puts in the terminal's title (without its spinner), else
-- what the agent is called.
function M.title(buf)
  local t = (vim.b[buf].term_title or ""):gsub("^[^%w]+", "")
  local kind = require("corkboard.agent").of(buf) or require("corkboard.agent").get()
  return vim.b[buf].corkboard_name or vim.b[buf].corkboard_handoff_title or (t ~= "" and t) or kind.label
end

-- Where a session runs, as its status line says it: brain@machine:vm -
-- account - directory, leaving out what isn't known. One on this
-- machine has no VM, and runs as the default brain. no_dir: just the
-- brain@machine:vm, for its tab.
function M.where(buf, no_dir)
  local b = vim.b[buf]
  local brain, vm, host, dir = b.corkboard_brain, b.corkboard_vm, b.corkboard_host, b.corkboard_dir
  local account = b.corkboard_account or (vm and brain and require("corkboard.brains").account_of(brain)) or nil
  if not vm then
    brain = brain or require("corkboard.brains").default_name() or "claude"
    host = vim.uv.os_gethostname()
    local cwd = vim.api.nvim_buf_get_name(buf):match("^term://(.-)//%d+:")
    dir = cwd and vim.fn.fnamemodify(cwd, ":~")
  end
  local place = host and vm and (host .. ":" .. vm) or host or vm
  local out = brain and (brain .. "@" .. place) or place
  if no_dir then return out end
  if account then out = out .. " - " .. account end
  return dir and (out .. " - " .. dir) or out
end

-- A fleet session, once it's running: its conversation, in a tab of its
-- own. fleetd has the spawn claimed and started within a minute or so; its
-- session shows among the bridges' when it has. Toast id's spinner stays up
-- till then, saying how far it's got.
local WAITING = { ["pending-approval"] = "waiting for approval", queued = "waiting for a VM", running = "connecting" }
function M.follow_spawn(spawn, label, id)
  local cloud = require("corkboard.cards.cloud")
  local ui = require("corkboard")
  id = id or ("session-" .. spawn.id)
  local tries = 0
  ui.toast(id, "pending", label .. ": waiting for a VM")
  local function look()
    tries = tries + 1
    cloud.call_async("fleet_get", function(err, fleet)
      local s = not err and vim.iter(fleet.spawns or {}):find(function(x) return x.id == spawn.id end)
      if s and (s.state == "failed" or s.state == "stopped" or s.state == "done") then
        return ui.toast(id, "error", label .. ": " .. s.state .. (s.error ~= vim.NIL and s.error and (" (" .. s.error .. ")") or ""))
      end
      local slot = s and s.slot ~= vim.NIL and s.slot or nil
      for _, b in ipairs(not err and fleet.bridges or {}) do
        for _, c in ipairs(b.sessions or {}) do
          if slot and c.vm == slot and b.environment == spawn.environment and c.attach then
            ui.toast(id, "done", label .. " is running in " .. slot)
            return require("corkboard.conversation").open(b.id, c.key, c.name or label, {
              vm = slot, brain = s.brain ~= vim.NIL and s.brain or nil, account = s.account ~= vim.NIL and s.account or nil, host = c.host ~= vim.NIL and c.host or b.machine, dir = c.project,
            })
          end
        end
      end
      if tries >= 60 then return ui.toast(id, "error", label .. " hasn't started after 3 minutes; the fleet view has it") end
      local state = s and (WAITING[s.state] or s.state) or "waiting for a VM"
      ui.toast(id, "pending", label .. ": " .. state .. (slot and (" to " .. slot) or ""))
      vim.defer_fn(look, 3000)
    end)
  end
  vim.defer_fn(look, 3000)
end

-- Whether this machine has the default agent, so a session can start here.
local function runs_here() return vim.fn.executable(require("corkboard.agent").get().exe) == 1 end

-- The sidebar's New Session: the default agent here when this machine has
-- it, else the choice open() gives.
function M.new_session()
  if runs_here() then return M.start() end
  M.open()
end

local function nil_if_null(v) return v ~= vim.NIL and v or nil end

-- Where brain (nil: none) can have a session, as corkboard.columns' right
-- column: here, when this machine has the agent; its own VMs (a resident of
-- its, a slot whose spawn is its, already running); and a new spawn for it
-- of each environment's templates, on this board's project.
local function places(brain, fleet, vms)
  local cloud = require("corkboard.cards.cloud")
  local out = {}
  if brain and runs_here() then
    table.insert(out, { text = "here", detail = vim.uv.os_gethostname(), run = function() M.start({ brain = brain }) end })
  end
  local spawns = {}
  for _, s in ipairs(fleet and fleet.spawns or {}) do spawns[s.id] = s end
  local function of(m) return m.resident and m.brain or (m.spawn and spawns[m.spawn] and nil_if_null(spawns[m.spawn].brain)) end
  local here = fleet and nil_if_null(fleet.machine) and fleet.machine.environment
  table.sort(vms, function(a, b) return a.environment .. a.name < b.environment .. b.name end)
  for _, m in ipairs(vms) do
    if (m.resident or m.spawn) and of(m) == brain then
      table.insert(out, {
        text = m.name,
        detail = m.environment .. (m.template and (" · " .. m.template) or ""),
        run = function() require("corkboard.fleet").open_vm(m) end,
      })
    end
  end
  for _, e in ipairs(fleet and fleet.environments or {}) do
    local slots = vim.tbl_get(e, "running", "slots") or {}
    local free = #vim.tbl_filter(function(sl) return nil_if_null(sl.spawn) == nil end, slots)
    local names = vim.tbl_keys(e.templates or {})
    table.sort(names)
    for _, t in ipairs(names) do
      -- One of its VMs already running t, on this machine, which can take
      -- another session over ssh.
      local vm = here == e.name and vim.iter(vms):find(function(m)
        return m.slot and m.spawn and spawns[m.spawn] and m.environment == e.name and m.template == t and of(m) == brain and m.config and nil_if_null(m.config.address)
      end)
      table.insert(out, vm and {
        text = "new " .. t,
        detail = e.name .. " · in " .. vm.name,
        run = function() require("corkboard.fleet").new_in_slot(vm) end,
      } or {
        text = "new " .. t,
        detail = string.format("%s · %d of %d free", e.name, free, #slots),
        run = function()
          local label = t .. " in " .. e.name .. (brain and (" for " .. brain) or "")
          local id = "session-" .. e.name .. "-" .. t
          require("corkboard").toast(id, "pending", "starting " .. label)
          cloud.call_async("fleet_session", function(err, spawn)
            if err then return require("corkboard").toast(id, "error", "couldn't start " .. label .. ": " .. tostring(err)) end
            M.follow_spawn(spawn, label, id)
          end, e.name, t, cloud.key() or vim.NIL, vim.NIL, brain or vim.NIL)
        end,
      })
    end
  end
  return out
end

-- <C-.>: an agent's session, for the brain chosen on the left, wherever
-- the right says it can run: here, one of its VMs, or a new one from the
-- fleet's templates, whose conversation opens when it's up.
function M.open()
  if require("corkboard.projects").need() then return end
  local cloud = require("corkboard.cards.cloud")
  local ok, got = pcall(cloud.call, "fleet_get")
  local fleet = ok and got or nil
  local vms = fleet and require("corkboard.fleet").vms(fleet) or {}
  local left = vim.tbl_map(function(b) return { text = b.name, brain = b.name } end, require("corkboard.brains").live())
  if fleet and #(fleet.environments or {}) > 0 then table.insert(left, { text = "no brain" }) end
  if #left == 0 then
    if runs_here() then return M.start() end
    return vim.notify("corkboard: no " .. require("corkboard.agent").get().exe .. " here, and no fleet to start a session in" .. (ok and "" or (": " .. tostring(got))), vim.log.levels.ERROR)
  end
  require("corkboard.columns").pick({
    title = "Session",
    key = "session",
    left = left,
    right = function(item) return places(item.brain, fleet, vim.deepcopy(vms)) end,
  })
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

-- Pepper's hand_off (hooks/handoff.lua, from the mod): an agent's tab in
-- the project, started on the task. req: task, project, name. Returns
-- whether it started, and what to tell Pepper.
function M.handoff(req)
  local corkboard = require("corkboard")
  if corkboard.window == "plan" or not corkboard.attached() then return false, "this Neovim has no page" end
  if type(req) ~= "table" or type(req.task) ~= "string" or req.task == "" then return false, "no task" end
  local dir, err = project_dir(req.project)
  if not dir then return false, err end
  local name = type(req.name) == "string" and req.name ~= "" and req.name or nil
  local kind = require("corkboard.agent").get()
  if not M.start({ cwd = dir, prompt = HANDOFF_PROMPT, name = name, task = req.task }) then return false, kind.exe .. " is not on PATH" end
  return true, string.format("started %s in %s%s", kind.label, vim.fn.fnamemodify(dir, ":~"), name and (", tab " .. name) or "")
end

return M
