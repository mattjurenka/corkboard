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
-- runs, which <C-`> opens there), worktree (false: start in cwd itself,
-- not a worktree of its own). The tab closes with the session, unless a
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
    -- No agent here yet: the page's Agents screen, rather than an error.
    if exe == kind.exe then
      require("corkboard.agent").install()
    else
      vim.notify("corkboard: " .. exe .. " is not on PATH", vim.log.levels.ERROR)
    end
    return nil
  end
  -- A worktree of its own, when it would start in a repository's main
  -- checkout (corkboard.worktree); one resumed goes on where it was.
  if not (opts.via or opts.attach or opts.resume) and opts.worktree ~= false then
    local ok, cwd, branch, note = pcall(require("corkboard.worktree").for_session, vim.fs.normalize(opts.cwd or vim.fn.getcwd()))
    if not ok then
      vim.notify("corkboard: " .. cwd, vim.log.levels.ERROR)
      return nil
    end
    if cwd then
      opts = vim.tbl_extend("force", opts, { cwd = cwd, branch = branch, prompt = opts.prompt and (note .. "\n\n" .. opts.prompt) or note })
    end
  end
  -- The node's tools, told the worktree's branch (corkboard.worktree).
  if not (opts.via or opts.attach) then
    opts = vim.tbl_extend("force", opts, { node_mcp = require("corkboard.worktree").mcp_config(opts.cwd or vim.fn.getcwd()) })
  end
  if kind.events == "acp" and not (opts.via or opts.attach) then
    if opts.here then vim.cmd.enew() elseif opts.split then vim.cmd("rightbelow vnew") else vim.cmd.tabnew() end
    local buf = vim.api.nvim_get_current_buf()
    vim.b[buf].corkboard_agent = kind.name
    vim.b[buf].corkboard_role = opts.role or "project"
    vim.b[buf].corkboard_brain = opts.brain
    vim.b[buf].corkboard_name = opts.name
    vim.b[buf].corkboard_branch = opts.branch
    return require("corkboard.acp").start(buf, kind, opts)
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
  -- Its worktree's branch, when it has one (corkboard.worktree).
  vim.b[buf].corkboard_branch = opts.branch
  -- For away mode's list (corkboard.away).
  vim.b[buf].corkboard_name = opts.name
  require("corkboard.terminal").start(cmd, {
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

-- Whether this machine has an agent, so a session can start here.
local function runs_here() return #require("corkboard.agent").here() > 0 end

-- The sidebar's New Session: the default agent here when this machine has
-- one, else the choice open() gives.
function M.new_session()
  if runs_here() then return M.start() end
  M.open()
end

local function nil_if_null(v) return v ~= vim.NIL and v or nil end

-- The agent a fleet environment's template runs: its `agent`, else Claude
-- Code's (a resident's, which has no template).
local function template_agent(fleet, env, t)
  local e = t and vim.iter(fleet and fleet.environments or {}):find(function(e) return e.name == env end)
  return e and nil_if_null(vim.tbl_get(e, "templates", t, "agent")) or require("corkboard.agent").DEFAULT
end

-- Where else brain (nil: none) can have a session of agent in the fleet:
-- its own VMs running agent (a resident of its, a slot whose spawn is its,
-- already running); and a new spawn for it of each environment's templates
-- that run agent, on this board's project.
local function fleet_places(brain, fleet, vms, agent)
  local cloud = require("corkboard.cards.cloud")
  local out = {}
  local spawns = {}
  for _, s in ipairs(fleet and fleet.spawns or {}) do spawns[s.id] = s end
  local function of(m) return m.resident and m.brain or (m.spawn and spawns[m.spawn] and nil_if_null(spawns[m.spawn].brain)) end
  local here = fleet and nil_if_null(fleet.machine) and fleet.machine.environment
  table.sort(vms, function(a, b) return a.environment .. a.name < b.environment .. b.name end)
  for _, m in ipairs(vms) do
    if (m.resident or m.spawn) and of(m) == brain and template_agent(fleet, m.environment, m.template) == agent then
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
    local names = vim.tbl_filter(function(t) return template_agent(fleet, e.name, t) == agent end, vim.tbl_keys(e.templates or {}))
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

-- A pick in columns: a choice in each, and to its right what that choice
-- offers. On the page it's a window of the page's (web/src/components/
-- Session.tsx), which calls run() with the leaf chosen; in a bare Neovim,
-- a vim.ui.select for each column in turn.
--
-- The last choice in each keyed pick, its texts column by column, kept
-- across restarts so the next open starts on it.
local function last_path() return vim.fs.joinpath(vim.fn.stdpath("state"), "corkboard", "picked.json") end

local function read_last()
  local f = io.open(last_path(), "r")
  if not f then return {} end
  local ok, got = pcall(vim.json.decode, f:read("*a"))
  f:close()
  return ok and type(got) == "table" and got or {}
end

local function save_last(key, path)
  local all = read_last()
  all[key] = { path = path }
  vim.fn.mkdir(vim.fs.dirname(last_path()), "p")
  local f = io.open(last_path(), "w")
  if not f then return end
  f:write(vim.json.encode(all))
  f:close()
end

-- The open pick's key, and its leaves by the id the page has for each:
-- { run, path }.
local leaves, leaves_key = {}, nil

local function run_leaf(key, path, run)
  if key then pcall(save_last, key, path) end
  vim.schedule(run)
end

-- The leaf the page chose.
function M.run(id)
  local leaf = leaves[id]
  leaves = {}
  if leaf then run_leaf(leaves_key, leaf.path, leaf.run) end
end

-- A bare Neovim's: list's choices, then what the one chosen offers.
local function select(list, title, key, path)
  vim.ui.select(list, {
    prompt = title,
    format_item = function(it) return it.detail and (it.text .. "  " .. it.detail) or it.text end,
  }, function(it)
    if not it then return end
    local to = vim.list_extend(vim.list_slice(path), { it.text })
    if it.items then
      if #it.items > 0 then select(it.items, it.text, key, to) end
    elseif it.run then
      run_leaf(key, to, it.run)
    end
  end)
end

-- opts: title; items, the first column's: a list of { text, detail?, run }
-- or { text, items }, items a list or a function(item) giving one; key, to
-- open on the last choice made in a pick with the same key.
local function pick(opts)
  if #opts.items == 0 then return end
  leaves, leaves_key = {}, opts.key
  -- Each item's own, once, as the page is sent them.
  local function expand(list, path)
    return vim.tbl_map(function(it)
      local to = vim.list_extend(vim.list_slice(path), { it.text })
      if type(it.items) == "function" then it.items = it.items(it) or {} end
      if it.items then return { text = it.text, detail = it.detail, items = expand(it.items, to) } end
      if not it.run then return { text = it.text, detail = it.detail } end
      table.insert(leaves, { run = it.run, path = to })
      return { text = it.text, detail = it.detail, id = #leaves }
    end, list)
  end
  local items = expand(opts.items, {})
  local corkboard = require("corkboard")
  if not corkboard.attached() then return select(opts.items, opts.title, opts.key, {}) end
  local last = opts.key and read_last()[opts.key]
  corkboard.notify("corkboard.session", { title = opts.title, items = items, last = last and type(last.path) == "table" and last.path or nil })
end

-- The agents brain can have a session of, as the pick's middle
-- column, each with where it can run: here when this machine has it
-- (start(brain, kind) starts it), unless brain is nil (none, which only
-- the fleet runs; false: none, here too), and the fleet's places that
-- run it.
local function agents(brain, start, fleet, vms)
  local kinds = require("corkboard.agent")
  local out = {}
  for _, kind in ipairs(kinds.all()) do
    local items = {}
    if brain ~= nil and kinds.runs_here(kind) then
      table.insert(items, { text = "here", detail = vim.uv.os_gethostname(), run = function() start(brain or nil, kind.name) end })
    end
    if fleet then vim.list_extend(items, fleet_places(brain, fleet, vim.deepcopy(vms), kind.name)) end
    if #items > 0 then table.insert(out, { text = kind.label, items = items }) end
  end
  return out
end

-- <C-.>: an agent's session, for the brain chosen on the left, of the agent
-- in the middle, wherever the right says it can run: here, one of its VMs,
-- or a new one from the fleet's templates, whose conversation opens when
-- it's up.
function M.open()
  if require("corkboard.projects").need() then return end
  local cloud = require("corkboard.cards.cloud")
  local ok, got = pcall(cloud.call, "fleet_get")
  local fleet = ok and got or nil
  local vms = fleet and require("corkboard.fleet").vms(fleet) or {}
  local start = function(brain, agent) M.start({ brain = brain, agent = agent }) end
  local left = vim.tbl_map(function(b) return { text = b.name, brain = b.name } end, require("corkboard.brains").live())
  if fleet and #(fleet.environments or {}) > 0 then table.insert(left, { text = "no brain" }) end
  if #left == 0 then
    if runs_here() then return M.start() end
    return require("corkboard.agent").install()
  end
  -- Brains, and nowhere to run one: no agent here and no fleet.
  if not runs_here() and not (fleet and #(fleet.environments or {}) > 0) then return require("corkboard.agent").install() end
  for _, it in ipairs(left) do
    it.items = function() return agents(it.brain, start, fleet, vms) end
  end
  pick({ title = "Session", key = "session", items = left })
end

-- The board's A: card id's session, for the brain on the left, of the agent
-- in the middle, which the card keeps; here, where its worktree is.
function M.open_card(id)
  if not runs_here() then return require("corkboard.agent").install() end
  local start = function(brain, agent)
    require("corkboard.board").set(id, { agent = agent })
    require("corkboard.agents").start(id, { brain = brain })
  end
  local left = vim.tbl_map(function(b) return { text = b.name, brain = b.name } end, require("corkboard.brains").live())
  table.insert(left, { text = "no brain", brain = false })
  for _, it in ipairs(left) do
    it.items = function() return agents(it.brain, start) end
  end
  pick({ title = id, key = "card", items = left })
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
