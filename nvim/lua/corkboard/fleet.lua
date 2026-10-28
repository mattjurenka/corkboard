-- Where the fleet's agents run (.agent/plans/agent-fleet.md): each
-- environment, as its fleetd last told the Worker, with the brains' VMs that
-- are always there, each slot and the spawn in it, and the memory budget
-- they share; then the spawns not over yet, and the last few that are.
--
-- The view is the agent://fleet buffer, third among the tabs after the board
-- and usage: a plain listing with the browser's HTML drawn over it. The
-- cursor's line selects a spawn. It follows the user's socket through the
-- bridge, which says when a spawn or an environment changes.

local pinned = require("corkboard.pinned")

local M = {}

local buf
local line_spawn = {} -- line number -> spawn id
local selected
local fleet -- { environments, spawns } as the bridge answers
local problem
local following = false

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

-- fleetd looks at least every minute; one not heard from in three is gone.
local function stale(e) return (age(e.seen) or math.huge) > 180 end

local function first_line(s)
  return (tostring(s or ""):match("^[^\n]*") or "")
end

local function nil_if_null(v)
  if v == vim.NIL then return nil end
  return v
end

local function state()
  local envs = {}
  for _, e in ipairs(fleet and fleet.environments or {}) do
    local running = nil_if_null(e.running)
    local templates = vim.tbl_keys(e.templates or {})
    table.sort(templates)
    table.insert(envs, {
      name = e.name, seen = e.seen, ago = ago(e.seen), stale = stale(e) or nil,
      running = running, templates = templates,
    })
  end
  local spawns = {}
  for _, s in ipairs(fleet and fleet.spawns or {}) do
    table.insert(spawns, {
      id = s.id, template = s.template, environment = s.environment, state = s.state,
      brain = nil_if_null(s.brain), by = s.by, task = first_line(s.task), board = s.board, card = s.card,
      slot = nil_if_null(s.slot), ago = ago(s.ended or s.started or s.created), error = nil_if_null(s.error),
    })
  end
  return { environments = envs, spawns = spawns, selected = selected, problem = problem, loading = (not fleet and not problem) or nil }
end

local function push_state()
  require("corkboard").notify("corkboard.fleet", state())
end

local function render_text()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local s = state()
  local lines, map = { "Fleet", "" }, {}
  if s.problem then table.insert(lines, "  " .. s.problem) end
  if s.loading then table.insert(lines, "  asking the Worker…") end
  for _, e in ipairs(s.environments) do
    local r = e.running
    local head = e.name:upper() .. "  · " .. (e.stale and ("not heard from since " .. e.ago) or ("seen " .. e.ago))
    if r and r.budget ~= vim.NIL then head = head .. string.format("  · %s of %s", gib(r.used), gib(r.budget)) end
    table.insert(lines, head)
    for _, v in ipairs(r and r.residents or {}) do
      table.insert(lines, string.format("  %-12s %-8s %-8s %10s", v.name, nil_if_null(v.brain) or "—", v.up and "up" or "down", gib(nil_if_null(v.memory))))
    end
    for _, sl in ipairs(r and r.slots or {}) do
      if nil_if_null(sl.spawn) then
        table.insert(lines, string.format("  %-12s %-8s %-8s %10s  %s", sl.name, "", sl.template, gib(nil_if_null(sl.memory)), sl.spawn))
      else
        table.insert(lines, string.format("  %-12s %-8s %-8s", sl.name, "", "free"))
      end
    end
    if not r then table.insert(lines, "  (its fleetd hasn't said what runs there)") end
    table.insert(lines, "  runs " .. table.concat(e.templates, ", "))
    table.insert(lines, "")
  end
  if #s.spawns > 0 then
    table.insert(lines, "SPAWNS      a approve · x stop · <CR> card · R refresh")
    for _, sp in ipairs(s.spawns) do
      table.insert(lines, string.format("  %-16s %-14s %-14s %-8s %-8s %s", sp.state, sp.template, sp.environment .. (sp.slot and ("/" .. sp.slot) or ""),
        sp.ago, sp.brain or "", require("corkboard.usage.transcript").short(sp.task, 50)))
      map[#lines] = sp.id
    end
  end
  pinned.set_lines(buf, lines)
  line_spawn = map
  pinned.follow(buf, line_spawn, selected)
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
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  if event.type == "spawn" or event.type == "fleet" or event.type == "reconnected" then reload() end
end

local function selected_spawn()
  for _, s in ipairs(fleet and fleet.spawns or {}) do
    if s.id == selected then return s end
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
function M.stop() act("fleet_stop", "stopping") end

-- The spawn's card, when it's on this project's board.
function M.open()
  local s = selected_spawn()
  if not s then return end
  local here = vim.env.CORKBOARD_BOARD and vim.fs.basename(vim.env.CORKBOARD_BOARD) or require("corkboard.util").path_key(vim.fn.getcwd())
  if s.board ~= here then return vim.notify("corkboard: " .. s.card .. " is on the " .. s.board .. " board") end
  require("corkboard.board").reveal(s.card)
end

-- A click on a spawn in the browser.
function M.select(id, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(line_spawn, id)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
end

-- While in sight, the ages move on.
local timer

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  timer = timer or assert(vim.uv.new_timer())
  buf = pinned.listing("agent://fleet", "fleet", {
    j = { function() pinned.step(line_spawn, 1) end, "next spawn" },
    k = { function() pinned.step(line_spawn, -1) end, "previous spawn" },
    ["<Down>"] = { function() pinned.step(line_spawn, 1) end, "next spawn" },
    ["<Up>"] = { function() pinned.step(line_spawn, -1) end, "previous spawn" },
    ["<CR>"] = { M.open, "the spawn's card" },
    a = { M.approve, "approve the spawn" },
    x = { M.stop, "stop the spawn" },
    R = { M.load, "refresh" },
  }, function() return line_spawn end, function(id)
    if id == selected then return end
    selected = id
    push_state()
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
