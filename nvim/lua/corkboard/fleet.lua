-- Where the fleet's agents run (.agent/plans/agent-fleet.md): each
-- environment, as its fleetd last told the Worker, with the memory budget
-- its VMs share and a card per machine that's up: this one, each brain's VM,
-- each slot with its spawn. On each card, the sessions there: the Claude
-- Code sessions of every page the bridge has open, Pepper's in its VM, a
-- slot's spawn. g groups the same sessions by project instead. Then the
-- spawns waiting or over, as the queue, at the foot.
--
-- The view is the agent://fleet buffer, third among the tabs after the board
-- and usage: a plain listing with the browser's HTML drawn over it. The
-- cursor's line selects a spawn or a session. It follows the user's socket
-- through the bridge, which says when a spawn or an environment changes, and
-- the bridge says when a session does.

local pinned = require("corkboard.pinned")

local M = {}

local buf
local line_item = {} -- line number -> spawn id, or a session's key
local blocks = {} -- the queue and each card, in order: { first, last } line numbers
local selected
local fleet -- { environments, spawns, machine } as the bridge answers
local sessions = {} -- every page's, as the bridge last said
local by = "machine" -- or "project"
local problem
local following = false
local asking -- { id, task }: x's "stop it?", until it's answered

local function cloud() return require("corkboard.cards.cloud") end

local function gib(mib) return mib and string.format("%.1f GiB", mib / 1024) or "—" end

-- Seconds since an ISO time.
local function age(iso)
  if type(iso) ~= "string" then return nil end
  local y, mo, d, h, mi, s = iso:match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
  if not y then return nil end
  local t = os.time({ year = y, month = mo, day = d, hour = h, min = mi, sec = s, isdst = false })
  -- os.time reads the fields as local time; this puts them back to UTC.
  local now = os.time()
  return now - t - os.difftime(now, os.time(os.date("!*t", now)))
end

local function ago(iso)
  local secs = age(iso)
  if not secs then return "" end
  if secs < 60 then return "now" end
  if secs < 3600 then return math.floor(secs / 60) .. "m ago" end
  if secs < 86400 then return math.floor(secs / 3600) .. "h ago" end
  return math.floor(secs / 86400) .. "d ago"
end

-- A session's since, in ms.
local function ago_ms(ms)
  if type(ms) ~= "number" then return "" end
  return ago(os.date("!%Y-%m-%dT%H:%M:%S", math.floor(ms / 1000)))
end

-- fleetd looks at least every minute; one not heard from in three is gone.
local function stale(e) return (age(e.seen) or math.huge) > 180 end

local function first_line(s)
  return (tostring(s or ""):match("^[^\n]*") or "")
end

local function nil_if_null(v)
  if v == vim.NIL then return nil end
  return v
end

local function session_key(c)
  if c.bridge then return "r" .. c.bridge .. "/" .. c.key end
  return "s" .. tostring(c.page) .. ":" .. tostring(c.buf)
end

-- Every other bridge's sessions, and fleetd's (in its VMs), each with its
-- bridge, its machine and its environment, from the Worker.
local function remote_sessions()
  local out = {}
  for _, b in ipairs(fleet and fleet.bridges or {}) do
    for _, s in ipairs(b.sessions or {}) do
      table.insert(out, vim.tbl_extend("force", s, { bridge = b.id, host = nil_if_null(s.host) or b.machine, environment = nil_if_null(b.environment) }))
    end
  end
  return out
end

-- What a selected row lists under it, as { label, value }, leaving out
-- what's unknown.
local function fields(list)
  local out = {}
  for _, f in ipairs(list) do
    local v = nil_if_null(f[2])
    if v ~= nil and v ~= "" then table.insert(out, { label = f[1], value = tostring(v) }) end
  end
  return out
end

-- A row on a card: a session, or the spawn in a slot. where is the machine,
-- for a card that's a project.
local function session_row(c, where)
  local since = c.state ~= "attached" and ago_ms(c.since) or ""
  local context = nil_if_null(c.context)
  return {
    id = session_key(c), state = c.state, title = c.name, project = c.project, where = where,
    ago = since, detail = nil_if_null(c.detail),
    context = context and { used = context, limit = require("corkboard.agents").context_limit() },
    info = fields({
      { "in", nil_if_null(c.vm) or nil_if_null(c.host) or (fleet and nil_if_null(fleet.machine) and fleet.machine.name) },
      { "role", c.role },
      { "card", c.card },
      { "session", nil_if_null(c.session) and c.session:sub(1, 8) },
      { "window", c.mine and "this one" or nil },
    }),
  }
end

local function spawn_row(s, where)
  return {
    id = s.id, spawn = true, state = s.state, title = first_line(s.task) ~= "" and first_line(s.task) or (s.template .. " session"), project = s.board, where = where,
    ago = ago(s.started or s.created), card = s.card,
    info = fields({
      { "spawn", s.id },
      { "template", s.template },
      { "in", s.environment .. (nil_if_null(s.slot) and ("/" .. s.slot) or "") },
      { "brain", s.brain },
      { "account", s.account },
      { "asked by", s.by },
      { "card", s.card and (s.card .. " on " .. tostring(s.board)) },
    }),
  }
end

local function spawn_entry(s)
  return {
    id = s.id, template = s.template, environment = s.environment, state = s.state,
    brain = nil_if_null(s.brain), by = s.by, task = first_line(s.task), board = s.board, card = s.card,
    slot = nil_if_null(s.slot), ago = ago(s.ended or s.started or s.created), error = nil_if_null(s.error),
  }
end

local function machine_key(env, name) return "m:" .. tostring(env) .. "/" .. tostring(name) end

-- A VM's config in a line, for its card: "2 cores · allowlist 4 · 10.80.0.2".
local function summary(c)
  if not c then return nil end
  local parts = {}
  if nil_if_null(c.cores) then table.insert(parts, c.cores .. " cores") end
  if c.egress == "open" then
    table.insert(parts, "open")
  else
    local n = #(c.allowedDomains or {}) + #(c.allowedDomainSuffixes or {})
    table.insert(parts, "allowlist " .. n .. (#(c.routedEgress or {}) > 0 and (" +" .. #c.routedEgress .. " routed") or ""))
  end
  if nil_if_null(c.address) then table.insert(parts, c.address) end
  return table.concat(parts, " · ")
end

-- A machine's busyness in a line, for its card: "12 threads · 9.8 GiB free".
local function host_summary(h)
  local parts = {}
  if nil_if_null(h.cores) then table.insert(parts, h.cores .. " threads") end
  if nil_if_null(h.available) then table.insert(parts, gib(h.available) .. " free") end
  if type(h.load) == "table" and h.load[1] then table.insert(parts, string.format("load %.2f", h.load[1])) end
  return #parts > 0 and table.concat(parts, " · ") or nil
end

-- Every VM fleetd told of, by machine_key: its name, what it runs, and its
-- config; and each machine they run on, as its fleetd describes it, or the
-- bridge for its own.
local function machines()
  local all = {}
  for _, e in ipairs(fleet and fleet.environments or {}) do
    local h = nil_if_null(e.running) and nil_if_null(e.running.host)
    if h then all[machine_key(e.name, h.name)] = { name = h.name, host = vim.tbl_extend("force", h, { environment = e.name }) } end
  end
  local here = fleet and nil_if_null(fleet.machine)
  if here then all[machine_key(here.environment, here.name)] = { name = here.name, host = here } end
  for _, e in ipairs(fleet and fleet.environments or {}) do
    local r = nil_if_null(e.running)
    for _, v in ipairs(r and r.residents or {}) do
      all[machine_key(e.name, v.name)] = { name = v.name, environment = e.name, resident = true, brain = nil_if_null(v.brain), memory = nil_if_null(v.memory), config = nil_if_null(v.config) }
    end
    for _, sl in ipairs(r and r.slots or {}) do
      all[machine_key(e.name, sl.name)] = { name = sl.name, environment = e.name, slot = true, spawn = nil_if_null(sl.spawn), template = nil_if_null(sl.template), memory = nil_if_null(sl.memory), config = nil_if_null(sl.config) }
    end
  end
  return all
end

local function duration(secs)
  if secs < 3600 then return math.floor(secs / 60) .. "m" end
  if secs < 86400 then return math.floor(secs / 3600) .. "h " .. math.floor(secs % 3600 / 60) .. "m" end
  return math.floor(secs / 86400) .. "d " .. math.floor(secs % 86400 / 3600) .. "h"
end

-- This machine: what it is, how busy it is, and what of the fleet runs on it.
local function describe_host(h)
  local fields = {}
  local function add(label, value)
    value = nil_if_null(value)
    if value ~= nil and value ~= "" then table.insert(fields, { label = label, values = { tostring(value) } }) end
  end
  add("os", h.os)
  add("kernel", h.kernel)
  add("cpu", nil_if_null(h.cpu) and (h.cpu .. " · " .. h.cores .. " threads") or (nil_if_null(h.cores) and (h.cores .. " threads")))
  if nil_if_null(h.memory) then
    add("memory", nil_if_null(h.available) and (gib(h.available) .. " free of " .. gib(h.memory)) or gib(h.memory))
  end
  if type(h.load) == "table" then add("load", table.concat(vim.tbl_map(function(n) return string.format("%.2f", n) end, h.load), " ")) end
  if nil_if_null(h.uptime) then add("up", duration(h.uptime)) end
  add("environment", h.environment)
  local here, vms = 0, 0
  local bridge = fleet and nil_if_null(fleet.machine)
  -- The bridge's sessions are on its own machine; another has none it knows of.
  local mine = bridge and bridge.name == h.name and bridge.environment == h.environment
  for _, c in ipairs(mine and sessions or {}) do
    if not nil_if_null(c.vm) and not nil_if_null(c.host) then here = here + 1 end
  end
  for _, e in ipairs(fleet and fleet.environments or {}) do
    local r = e.name == h.environment and nil_if_null(e.running)
    for _, v in ipairs(r and r.residents or {}) do
      if v.up then vms = vms + 1 end
    end
    for _, sl in ipairs(r and r.slots or {}) do
      if nil_if_null(sl.spawn) then vms = vms + 1 end
    end
  end
  add("sessions", here)
  add("vms up", vms)
  return {
    name = h.name, fields = fields,
    host = {
      os = nil_if_null(h.os), kernel = nil_if_null(h.kernel), cpu = nil_if_null(h.cpu), cores = nil_if_null(h.cores),
      memory = nil_if_null(h.memory), available = nil_if_null(h.available),
      load = type(h.load) == "table" and h.load or nil, up = nil_if_null(h.uptime) and duration(h.uptime),
      environment = nil_if_null(h.environment), sessions = here, vms = vms,
    },
  }
end

-- The selected machine's config, field by field, each with its values.
local function describe(m)
  if m and m.host then return describe_host(m.host) end
  local c = m and m.config
  if not c then return nil end
  local fields = {}
  local function add(label, values)
    if type(values) ~= "table" then values = { values } end
    if #values > 0 then table.insert(fields, { label = label, values = values }) end
  end
  local caps = c.capabilities or {}
  if m.template then
    add("template", m.template .. (#caps > 0 and (" (" .. table.concat(caps, ", ") .. ")") or ""))
  else
    if m.brain then add("brain", m.brain) end
    add("capabilities", #caps > 0 and table.concat(caps, ", ") or {})
  end
  if nil_if_null(c.account) then add("account", c.account) end
  if m.memory then add("memory", gib(m.memory)) end
  if nil_if_null(c.cores) then add("cores", tostring(c.cores)) end
  if nil_if_null(c.address) then add("address", c.address) end
  local egress = { c.egress }
  for _, d in ipairs(c.allowedDomains or {}) do table.insert(egress, d) end
  for _, d in ipairs(c.allowedDomainSuffixes or {}) do table.insert(egress, "*." .. d) end
  add("egress", egress)
  for _, r in ipairs(c.routedEgress or {}) do
    local ports = {}
    for _, p in ipairs(r.tcpPorts or {}) do table.insert(ports, "tcp " .. p) end
    for _, p in ipairs(r.udpPorts or {}) do table.insert(ports, "udp " .. p) end
    add("routed", { first_line(r.reason), table.concat(r.destinations or {}, ", ") .. "  " .. table.concat(ports, ", ") })
  end
  if c.needsApproval ~= nil and c.needsApproval ~= vim.NIL then add("approval", c.needsApproval and "needed for a brain's spawn" or "not needed") end
  local routed = vim.tbl_map(function(r)
    local ports = {}
    for _, p in ipairs(r.tcpPorts or {}) do table.insert(ports, "tcp " .. p) end
    for _, p in ipairs(r.udpPorts or {}) do table.insert(ports, "udp " .. p) end
    return { reason = first_line(r.reason), to = r.destinations or {}, ports = ports }
  end, c.routedEgress or {})
  return {
    name = m.name, fields = fields,
    vm = {
      kind = m.template or m.brain, capabilities = caps, account = nil_if_null(c.account),
      memory = m.memory, cores = nil_if_null(c.cores), address = nil_if_null(c.address),
      egress = nil_if_null(c.egress), domains = nil_if_null(c.egress) and vim.list_slice(egress, 2) or egress, routed = routed,
      approval = c.needsApproval ~= vim.NIL and c.needsApproval or nil,
    },
  }
end

-- Each environment with a card per machine that's up and its sessions.
local function by_machine(machine, spawns, shown)
  local groups = {}
  local envs = vim.deepcopy(fleet and fleet.environments or {})
  local here = machine and machine.environment
  -- Sessions on a machine whose fleetd the Worker hasn't heard of.
  if here and not vim.iter(envs):any(function(e) return e.name == here end) then
    table.insert(envs, { name = here })
  end
  for _, e in ipairs(envs) do
    local r = nil_if_null(e.running)
    local cards, idle = {}, {}
    if e.name == here then
      -- This machine, and any other one a page is open on.
      local hosts, order = {}, {}
      for _, c in ipairs(sessions) do
        if not nil_if_null(c.vm) then
          local name = nil_if_null(c.host) or machine.name
          if not hosts[name] then
            hosts[name] = { name = name, label = "host", rows = {} }
            table.insert(order, name)
          end
          table.insert(hosts[name].rows, session_row(c))
        end
      end
      if not hosts[machine.name] then table.insert(order, 1, machine.name) end
      hosts[machine.name] = hosts[machine.name] or { name = machine.name, label = "host", rows = {} }
      hosts[machine.name].summary = host_summary(machine)
      for _, name in ipairs(order) do table.insert(cards, hosts[name]) end
    elseif r and nil_if_null(r.host) then
      -- The machine another environment's fleetd runs on.
      table.insert(cards, { name = r.host.name, label = "host", summary = host_summary(r.host), rows = {} })
    end
    for _, v in ipairs(r and r.residents or {}) do
      if v.up then
        table.insert(cards, { name = v.name, label = nil_if_null(v.brain), memory = gib(nil_if_null(v.memory)), summary = summary(nil_if_null(v.config)), rows = {} })
      else
        table.insert(idle, v.name .. " down")
      end
    end
    for _, sl in ipairs(r and r.slots or {}) do
      local id = nil_if_null(sl.spawn)
      if id then
        local card = { name = sl.name, label = nil_if_null(sl.template), memory = gib(nil_if_null(sl.memory)), summary = summary(nil_if_null(sl.config)), rows = {} }
        for _, s in ipairs(spawns) do
          if s.id == id then
            table.insert(card.rows, spawn_row(s))
            shown[s.id] = true
          end
        end
        table.insert(cards, card)
      else
        table.insert(cards, { name = sl.name, label = nil_if_null(sl.template), memory = gib(nil_if_null(sl.memory)), summary = "free", rows = {} })
      end
    end
    -- Another machine's sessions on a card of its own; a VM's go below.
    local theirs = vim.iter(remote_sessions()):filter(function(c) return c.environment == e.name end):totable()
    for _, c in ipairs(theirs) do
      if not nil_if_null(c.vm) then
        local card = vim.iter(cards):find(function(card) return card.name == c.host end)
        if not card then
          card = { name = c.host, label = "host", rows = {} }
          table.insert(cards, card)
        end
        table.insert(card.rows, session_row(c))
      end
    end
    -- Sessions in a VM go on its card, made for one fleetd doesn't say is up.
    for _, c in ipairs(vim.list_extend(vim.list_slice(e.name == here and sessions or {}), theirs)) do
      local vm = nil_if_null(c.vm)
      if vm then
        local card = vim.iter(cards):find(function(card) return card.name == vm end)
        if not card then
          card = { name = vm, rows = {} }
          table.insert(cards, card)
        end
        table.insert(card.rows, session_row(c))
      end
    end
    for _, card in ipairs(cards) do
      card.id = machine_key(e.name, card.name)
      for _, row in ipairs(card.rows) do row.machine = card.id end
    end
    -- The agents' memory budget; with none, the machine's own memory in use.
    local budget, used, ram = r and nil_if_null(r.budget), r and r.used, nil
    local h = r and nil_if_null(r.host)
    if e.name == here then h = machine end
    if not budget and h and nil_if_null(h.memory) and nil_if_null(h.available) then
      budget, used, ram = h.memory, h.memory - h.available, true
    end
    table.insert(groups, {
      name = e.name, ago = e.seen and ago(e.seen) or nil, stale = (e.seen and stale(e)) or nil,
      budget = budget, used = used, ram = ram, idle = idle, cards = cards,
      silent = (e.seen and not r) or nil,
    })
  end
  return groups
end

-- One card per project, each session saying where it runs.
local function by_project(machine, spawns, shown)
  local cards, index = {}, {}
  local function add(project, row)
    project = project or "—"
    if not index[project] then
      index[project] = { name = project, rows = {} }
      table.insert(cards, index[project])
    end
    table.insert(index[project].rows, row)
  end
  local here = machine and machine.environment
  for _, c in ipairs(vim.list_extend(vim.list_slice(sessions), remote_sessions())) do
    local where = nil_if_null(c.vm) or nil_if_null(c.host) or (machine and machine.name)
    local row = session_row(c, where)
    row.machine = machine_key(here, where)
    add(c.project, row)
  end
  for _, s in ipairs(spawns) do
    if s.state == "running" then
      local row = spawn_row(s, s.environment .. (nil_if_null(s.slot) and ("/" .. s.slot) or ""))
      row.machine = nil_if_null(s.slot) and machine_key(s.environment, s.slot)
      add(s.board, row)
      shown[s.id] = true
    end
  end
  table.sort(cards, function(a, b) return a.name < b.name end)
  return { { cards = cards } }
end

local function state()
  local machine = fleet and nil_if_null(fleet.machine)
  local spawns = fleet and fleet.spawns or {}
  local shown = {}
  local groups = (by == "project" and by_project or by_machine)(machine, spawns, shown)
  -- The queue: what's waiting or over, and a running spawn no card shows.
  local queue = {}
  for _, s in ipairs(spawns) do
    if not shown[s.id] then table.insert(queue, spawn_entry(s)) end
  end
  -- The machine selected, or the one the selected session is on.
  local at = selected and selected:match("^m:") and selected
  for _, g in ipairs(groups) do
    for _, card in ipairs(g.cards) do
      for _, row in ipairs(card.rows) do
        if row.id == selected then at = row.machine end
      end
    end
  end
  return {
    by = by, queue = queue, asking = asking, groups = groups, selected = selected, detail = at and describe(machines()[at]) or nil,
    problem = problem, loading = (not fleet and not problem) or nil,
  }
end

local function push_state()
  require("corkboard").notify("corkboard.fleet", state())
end

local function render_text()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local s = state()
  local short = require("corkboard.usage.transcript").short
  local lines, map, spans = { "Fleet      j/k · h/l card · a approve · x stop · <CR> open · g by " .. (by == "machine" and "project" or "machine") .. " · R refresh", "" }, {}, {}
  if s.problem then table.insert(lines, "  " .. s.problem) end
  if s.asking then table.insert(lines, "  stop " .. short(s.asking.task, 50) .. "?  y yes · n no") end
  if s.loading then table.insert(lines, "  asking the Worker…") end
  for _, g in ipairs(s.groups) do
    if g.name then
      local head = { g.name:upper() }
      if g.budget then table.insert(head, string.format("%s of %s%s", gib(g.used), gib(g.budget), g.ram and " RAM" or "")) end
      if g.ago then table.insert(head, g.stale and ("not heard from since " .. g.ago) or ("seen " .. g.ago)) end
      vim.list_extend(head, g.idle or {})
      table.insert(lines, table.concat(head, "  · "))
    end
    if g.silent then table.insert(lines, "  (its fleetd hasn't said what runs there)") end
    if g.name and #g.cards == 0 and not g.silent then table.insert(lines, "  nothing running") end
    for _, card in ipairs(g.cards) do
      table.insert(lines, "  " .. card.name .. (card.label and ("  " .. card.label) or "") .. (card.memory and ("  " .. card.memory) or ""))
      local from = #lines
      if card.id then map[#lines] = card.id end
      if card.summary then table.insert(lines, "    " .. card.summary) end
      if #card.rows == 0 then table.insert(lines, "    no session") end
      for _, row in ipairs(card.rows) do
        table.insert(lines, string.format("    %-10s %-14s %-8s %s", row.state, row.where or row.project or "", row.ago, short(row.title, 50)))
        map[#lines] = row.id
      end
      table.insert(spans, { from, #lines })
    end
    table.insert(lines, "")
  end
  if s.detail then
    table.insert(lines, s.detail.name)
    for _, f in ipairs(s.detail.fields) do
      for i, v in ipairs(f.values) do
        table.insert(lines, string.format("  %-13s %s", i == 1 and f.label or "", v))
      end
    end
    table.insert(lines, "")
  end
  if #s.queue > 0 then
    table.insert(lines, "QUEUE")
    local from = #lines + 1
    for _, sp in ipairs(s.queue) do
      table.insert(lines, string.format("  %-16s %-14s %-8s %-8s %s", sp.state, sp.template, sp.environment, sp.ago, short(sp.task, 50)))
      map[#lines] = sp.id
    end
    table.insert(spans, { from, #lines })
  end
  pinned.set_lines(buf, lines)
  line_item = map
  blocks = {}
  for _, span in ipairs(spans) do
    for l = span[1], span[2] do
      if map[l] then
        table.insert(blocks, { first = l, last = span[2] })
        break
      end
    end
  end
  pinned.follow(buf, line_item, selected)
end

local function redraw()
  render_text()
  push_state()
end

-- What the Worker has now; on the user's socket from the first.
function M.load()
  if not cloud().enabled() then
    problem = "the fleet view needs corkboard's bridge and the cloud"
    return redraw()
  end
  local ok, res = pcall(function()
    if not following then
      cloud().call("fleet_subscribe")
      following = true
    end
    return cloud().call("fleet_get")
  end)
  if ok then
    fleet, problem = res, nil
    sessions = res.sessions or {}
  else
    problem = tostring(res)
  end
  redraw()
end

-- Changes come in bursts (a spawn's claim, its state, the slot's): one
-- load for each.
local pending = false
local function reload()
  if pending then return end
  pending = true
  vim.defer_fn(function()
    pending = false
    M.load()
  end, 300)
end

-- From the bridge: the user's socket.
function M.cloud_event(event)
  -- A conversation followed from here (corkboard.conversation), open or not.
  if event.type == "conversation" or event.type == "conversation_end" then return require("corkboard.conversation").event(event) end
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  if event.type == "spawn" or event.type == "fleet" or event.type == "reconnected" then reload() end
  -- Another bridge's sessions, as they change.
  if event.type == "bridge" and fleet and event.bridge then
    local list = vim.iter(fleet.bridges or {}):filter(function(b) return b.id ~= event.bridge.id end):totable()
    if not event.bridge.gone and event.bridge.id ~= fleet.self then table.insert(list, event.bridge) end
    fleet.bridges = list
    redraw()
  end
end

-- From the bridge: every page's sessions, whenever one of them changes.
function M.sessions(list)
  sessions = list
  if buf and vim.api.nvim_buf_is_valid(buf) then redraw() end
end

local function selected_spawn()
  for _, s in ipairs(fleet and fleet.spawns or {}) do
    if s.id == selected then return s end
  end
end

local function selected_session()
  for _, c in ipairs(vim.list_extend(vim.list_slice(sessions), remote_sessions())) do
    if session_key(c) == selected then return c end
  end
end

local function act(op, verb)
  local s = selected_spawn()
  if not s then return end
  local ok, err = pcall(cloud().call, op, s.id)
  if not ok then vim.notify("corkboard: " .. verb .. " " .. s.id .. ": " .. tostring(err), vim.log.levels.WARN) end
  reload()
end

function M.approve() act("fleet_approve", "approving") end

-- x asks first; a yes stops it, with a toast while the Worker answers.
function M.stop()
  local s = selected_spawn()
  if not s then return end
  asking = { id = s.id, task = s.task ~= "" and s.task or s.id }
  redraw()
end

function M.answer(yes)
  local a = asking
  if not a then return end
  asking = nil
  redraw()
  if not yes then return end
  local ui = require("corkboard")
  local id, name = "stop-" .. a.id, require("corkboard.usage.transcript").short(a.task, 40)
  ui.toast(id, "pending", "stopping " .. name)
  local ok, err = pcall(cloud().call, "fleet_stop", a.id)
  if ok then
    ui.toast(id, "done", "stopped " .. name)
  else
    ui.toast(id, "error", "couldn't stop " .. name .. ": " .. tostring(err))
  end
  reload()
end

-- While x's question is up, these answer it; otherwise, what they did.
local function or_answer(yes, otherwise)
  return function()
    if asking then return M.answer(yes) end
    if otherwise then otherwise() end
  end
end

-- A session's terminal, when it's in this Neovim; a spawn's card, when
-- it's on this project's board; a brain's session, in its VM.
-- The same options as the hosts' <name>-ssh: a guest's host key changes
-- whenever its disk does, so there's nothing to check it against.
local GUEST_SSH = {
  "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "GlobalKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10",
}

-- A session in a slot: what's running there, or (a free one) a new
-- interactive spawn in its environment. fleetd picks the slot.
local function open_slot(m)
  if m.spawn then
    for _, c in ipairs(remote_sessions()) do
      if nil_if_null(c.vm) == m.name and c.environment == m.environment and c.attach then
        return require("corkboard.conversation").open(c.bridge, c.key, c.name)
      end
    end
    return vim.notify("corkboard: " .. m.name .. "'s spawn has no conversation to follow")
  end
  local env = vim.iter(fleet and fleet.environments or {}):find(function(e) return e.name == m.environment end)
  local names = vim.tbl_keys(env and env.templates or {})
  table.sort(names)
  if #names == 0 then return vim.notify("corkboard: " .. m.environment .. " has no templates") end
  local function go(template)
    if not template then return end
    local ui = require("corkboard")
    local id = "session-" .. m.environment
    ui.toast(id, "pending", "starting a " .. template .. " session in " .. m.environment)
    local ok, err = pcall(cloud().call, "fleet_session", m.environment, template)
    if ok then
      ui.toast(id, "done", template .. " session queued in " .. m.environment)
    else
      ui.toast(id, "error", "couldn't start a session in " .. m.environment .. ": " .. tostring(err))
    end
    reload()
  end
  if #names == 1 then return go(names[1]) end
  vim.ui.select(names, { prompt = "Template" }, go)
end

-- Where a guest keeps its brain's corkboard token, which its managed MCP
-- server and memory hooks send (brain-vm's configuration).
local GUEST_TOKEN = "$HOME/.config/corkboard/token"
-- A guest's clones of the host's repos, by the repo's directory name.
local GUEST_WORK = "/var/lib/second-brain/work/"

-- A session in a VM: Pepper's own; in another VM on this machine, a new
-- Claude Code over ssh as its login user, whose login shell has the VM's
-- credentials and working directory (brain-vm's /opt/second-brain), or
-- this project's clone in there, when it has one. A brain's VM gets a
-- fresh token for its brain first: they last a week.
local function open_vm(m)
  if m.slot then return open_slot(m) end
  if m.brain == "pepper" then return require("corkboard.plan.claude").focus() end
  local here = fleet and nil_if_null(fleet.machine) and fleet.machine.environment
  if m.environment ~= here then return vim.notify("corkboard: " .. m.name .. " is in " .. m.environment .. ", out of reach from here") end
  local address = m.config and nil_if_null(m.config.address)
  if not address then return vim.notify("corkboard: fleetd gave no address for " .. m.name) end
  local login = "claude@" .. address
  if m.brain then
    local ok, t = pcall(cloud().brain_token, m.brain)
    local wrote = ok and vim.system(vim.list_extend(vim.list_extend({ "ssh" }, GUEST_SSH), {
      login, "umask 077; mkdir -p " .. vim.fs.dirname(GUEST_TOKEN) .. " && cat > " .. GUEST_TOKEN,
    }), { stdin = t.token }):wait(20000)
    if not ok then
      vim.notify("corkboard: no corkboard token for the " .. m.brain .. " brain: " .. tostring(t), vim.log.levels.WARN)
    elseif wrote.code ~= 0 then
      vim.notify("corkboard: couldn't give " .. m.name .. " its corkboard token: " .. vim.trim(wrote.stderr or ""), vim.log.levels.WARN)
    end
  end
  local project = vim.fs.basename(require("corkboard.util").project_root(vim.fn.getcwd(-1, -1)))
  local script = "cd " .. vim.fn.shellescape(GUEST_WORK .. project) .. " 2>/dev/null; exec claude"
  -- Which terminal it's in, which the guest publishes with its state
  -- (corkboard.away reads it).
  local cmd = vim.list_extend({ "ssh", "-t", "-o", "SendEnv=CORKBOARD_BUF NVIM" }, GUEST_SSH)
  vim.list_extend(cmd, { login, "bash -lc " .. vim.fn.shellescape(script) })
  local shell = vim.list_extend(vim.list_extend({ "ssh", "-t" }, GUEST_SSH), {
    login, "cd " .. vim.fn.shellescape(GUEST_WORK .. project) .. " 2>/dev/null; exec bash -l",
  })
  require("corkboard.claude").start({ attach = cmd, vm = m.name, shell = shell, args = { "--name", m.brain or m.name } })
end

-- A project's clone on this machine, the first of the account's projects
-- that match.
local function clone_here(match)
  local ok, listed = pcall(require("corkboard.picker").account_projects)
  for _, p in ipairs(ok and listed.projects or {}) do
    if p.path and match(p) then return p.path end
  end
end

-- run ({ module, function, args... }) in the project's window: the one
-- there is, brought forward, or a new one (the bridge's openWindow).
local function in_window(path, run) require("corkboard").notify("corkboard.open", { cwd = path, run = run }) end

function M.open()
  local m = selected and selected:match("^m:") and machines()[selected]
  if m and (m.resident or m.slot) then return open_vm(m) end
  local c = selected_session()
  if c then
    if c.mine then return require("corkboard.terminal").focus(c.buf) end
    if c.bridge then
      if not c.attach then return vim.notify("corkboard: " .. c.name .. " has no conversation to follow") end
      -- Another project's, in that project's window if it's cloned here.
      local here = vim.fs.basename(require("corkboard.util").project_root(vim.fn.getcwd(-1, -1)))
      local path = c.project ~= here and clone_here(function(p) return vim.fs.basename(p.path) == c.project end)
      if path then return in_window(path, { "corkboard.conversation", "open", c.bridge, c.key, c.name }) end
      return require("corkboard.conversation").open(c.bridge, c.key, c.name)
    end
    -- Another window's: there, brought forward.
    return require("corkboard").notify("corkboard.away", "show", c.page, c.buf)
  end
  local s = selected_spawn()
  if not s then return end
  local here = vim.env.CORKBOARD_BOARD and vim.fs.basename(vim.env.CORKBOARD_BOARD) or require("corkboard.cards.cloud").key()
  if s.board == here then return require("corkboard.board").reveal(s.card) end
  local path = clone_here(function(p) return p.key == s.board end)
  if not path then return vim.notify("corkboard: " .. s.card .. " is on the " .. s.board .. " board, which isn't cloned here") end
  in_window(path, { "corkboard.board", "reveal", s.card })
end

-- h/l: the previous or next card (the queue last of them). Past the
-- first or the last, nothing; Alt+h/l (lhs) do what they do everywhere else:
-- the next window, or the page's tabs.
local function card_step(dir, lhs)
  local here = vim.api.nvim_win_get_cursor(0)[1]
  -- The card the cursor is in, or (between them) the one before it, which
  -- Alt+h goes back to.
  local to
  for i, b in ipairs(blocks) do
    if here >= b.first and here <= b.last then
      to = i + dir
    elseif b.first < here then
      to = dir > 0 and i + 1 or i
    end
  end
  to = to or (dir > 0 and 1 or 0)
  if blocks[to] then return vim.api.nvim_win_set_cursor(0, { blocks[to].first, 2 }) end
  if not lhs then return end
  for _, map in ipairs(vim.api.nvim_get_keymap("n")) do
    if vim.keycode(map.lhs) == vim.keycode(lhs) then
      if map.callback then return map.callback() end
      return vim.api.nvim_feedkeys(vim.keycode(map.rhs or ""), "m", false)
    end
  end
end

function M.group()
  by = by == "machine" and "project" or "machine"
  redraw()
end

-- A click on a spawn or a session in the browser.
function M.select(id, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(line_item, id)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
end

-- While in sight, the ages move on.
local timer

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  timer = timer or assert(vim.uv.new_timer())
  buf = pinned.listing("agent://fleet", "fleet", {
    j = { function() pinned.step(line_item, 1) end, "next" },
    k = { function() pinned.step(line_item, -1) end, "previous" },

    ["<CR>"] = { or_answer(true, M.open), "the session, or the spawn's card" },
    y = { or_answer(true), "yes, stop it" },
    n = { or_answer(false), "no, leave it" },
    ["<Esc>"] = { or_answer(false), "no, leave it" },
    a = { M.approve, "approve the spawn" },
    x = { M.stop, "stop the spawn" },
    g = { M.group, "group by machine or project" },
    R = { M.load, "refresh" },
    h = { function() card_step(-1) end, "previous card" },
    l = { function() card_step(1) end, "next card" },

    ["<A-h>"] = { function() card_step(-1, "<A-h>") end, "previous card" },
    ["<A-l>"] = { function() card_step(1, "<A-l>") end, "next card" },
  }, function() return line_item end, function(id)
    if id == selected then return end
    selected = id
    -- Moving off the spawn takes the question back.
    if asking and asking.id ~= id then asking = nil end
    -- The detail at the foot follows it.
    redraw()
  end)
  vim.api.nvim_create_autocmd("BufWinEnter", {
    buffer = buf,
    callback = function()
      if not timer:is_active() then
        timer:start(30000, 30000, vim.schedule_wrap(function()
          if #vim.fn.win_findbuf(buf) == 0 then return timer:stop() end
          redraw()
        end))
      end
    end,
  })
  vim.api.nvim_create_autocmd("BufEnter", { buffer = buf, callback = function() vim.schedule(M.load) end })
  return buf
end

-- Keep the fleet view third among the tabs, after usage. Leaves focus
-- where it was.
function M.ensure()
  if pinned.ensure("corkboard_fleet", 3, buffer()) then vim.schedule(M.load) end
end

function M.show()
  M.ensure()
  pinned.show("corkboard_fleet", 3, buffer())
end

-- For a channel that just attached: the last state again, if the view exists.
function M.push_all()
  if buf and vim.api.nvim_buf_is_valid(buf) then push_state() end
end

-- What the page is sent, for tests.
M.state = state

return M
