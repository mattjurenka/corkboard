-- Token use of the Claude Code sessions in this project, and what it went on
-- (corkboard.usage.transcript reads the logs).
--
-- Claude Code logs every session to ~/.claude/projects/<cwd with every
-- non-alphanumeric as ->/<session>.jsonl, and each subagent to
-- <session>/subagents/agent-<id>.jsonl beside a .meta.json naming its type.
--
-- The view is the agent://usage buffer: a plain listing with the browser's
-- HTML drawn over it, like the board. It lists the sessions active in a
-- period (a log written to within it), newest first or by cost; the cursor's
-- line selects one.

local pinned = require("corkboard.pinned")
local transcript = require("corkboard.usage.transcript")

local M = {}

local short = transcript.short

-- The periods `p` cycles through. A session counts when its log was last
-- written within the period; its cost is still the whole session's.
local PERIODS = {
  { key = "day", label = "24h", secs = 86400 },
  { key = "week", label = "7d", secs = 7 * 86400 },
  { key = "month", label = "30d", secs = 30 * 86400 },
  { key = "all", label = "all" },
}
local SORTS = { recent = "recent", cost = "cost" }

local function project_dir(cwd)
  local config = vim.env.CLAUDE_CONFIG_DIR or vim.fs.joinpath(vim.uv.os_homedir(), ".claude")
  return vim.fs.joinpath(config, "projects", (cwd:gsub("[^%w]", "-")))
end

local function read_meta(path)
  local ok, lines = pcall(vim.fn.readfile, path)
  if not ok then return {} end
  local decoded = vim.F.npcall(vim.json.decode, table.concat(lines, "\n"))
  return type(decoded) == "table" and decoded or {}
end

-- The sessions in this project written to since `since` (any, when nil),
-- newest first, each with its subagents and whether any of its logs grew;
-- and whether any log grew at all.
local function scan(cwd, since)
  local dir = project_dir(cwd)
  local files = {}
  if vim.fn.isdirectory(dir) == 1 then
    for name, kind in vim.fs.dir(dir) do
      if kind == "file" and name:match("%.jsonl$") then
        local path = vim.fs.joinpath(dir, name)
        local stat = vim.uv.fs_stat(path)
        if stat then table.insert(files, { path = path, id = name:gsub("%.jsonl$", ""), mtime = stat.mtime.sec }) end
      end
    end
  end
  table.sort(files, function(a, b) return a.mtime > b.mtime end)

  local sessions, changed = {}, false
  for _, f in ipairs(files) do
    if since and f.mtime < since then break end
    local log, grew = transcript.read(f.path, cwd)
    local session = { id = f.id, log = log, agents = {}, grew = grew }
    local sub = vim.fs.joinpath(dir, f.id, "subagents")
    if vim.fn.isdirectory(sub) == 1 then
      for name, kind in vim.fs.dir(sub) do
        if kind == "file" and name:match("%.jsonl$") then
          local alog, agrew = transcript.read(vim.fs.joinpath(sub, name), cwd)
          session.grew = session.grew or agrew
          alog.meta = alog.meta or read_meta(vim.fs.joinpath(sub, (name:gsub("%.jsonl$", ".meta.json"))))
          table.insert(session.agents, alog)
        end
      end
    end
    changed = changed or session.grew
    table.insert(sessions, session)
  end
  return sessions, changed
end

-- Cards -----------------------------------------------------------------------
--
-- What each card's agents cost, from the sessions corkboard.agents started on
-- it (sessions.json beside the board). Those run in worktrees, so their logs
-- are under other project directories, out of scan()'s sight, and are read by
-- path instead. A session's cost is its cost-state's total (subagents
-- included); tokens are its own log's.

-- id -> { cost (nil until a session records one), tokens, sessions, today
-- (the cost of sessions started since local midnight) }
function M.card_costs()
  local out = {}
  local midnight = os.time(vim.tbl_extend("force", os.date("*t"), { hour = 0, min = 0, sec = 0 }))
  for id, list in pairs(require("corkboard.agents").card_sessions()) do
    local c = { tokens = 0, sessions = 0, today = 0 }
    for _, s in ipairs(list) do
      if s.transcript and vim.uv.fs_stat(s.transcript) then
        local log = transcript.read(s.transcript, vim.fn.getcwd())
        local t = log.tokens
        c.sessions = c.sessions + 1
        c.tokens = c.tokens + t.input + t.write + t.read + t.output
        local cost = log.cost and log.cost.totalCostUSD
        if cost then
          c.cost = (c.cost or 0) + cost
          if (s.started or 0) >= midnight then c.today = c.today + cost end
        end
      end
    end
    if c.sessions > 0 then out[id] = c end
  end
  return out
end

-- The cards with costs, most expensive first, and the same added up by label
-- (a card with two labels counts in both).
local function by_card(costs)
  if vim.tbl_isempty(costs) then return {}, {} end
  local cards, labels = {}, {}
  for _, card in ipairs(require("corkboard.cards").list()) do
    local c = costs[card.id]
    if c then
      table.insert(cards, { id = card.id, title = card.title, labels = card.labels or {}, cost = c.cost, tokens = c.tokens, sessions = c.sessions })
      for _, label in ipairs(#(card.labels or {}) > 0 and card.labels or { "(no label)" }) do
        labels[label] = labels[label] or { label = label, cost = 0, cards = 0 }
        labels[label].cost = labels[label].cost + (c.cost or 0)
        labels[label].cards = labels[label].cards + 1
      end
    end
  end
  table.sort(cards, function(a, b) return (a.cost or -1) > (b.cost or -1) end)
  local label_list = vim.tbl_values(labels)
  table.sort(label_list, function(a, b) return a.cost > b.cost end)
  return cards, label_list
end

-- The agent://usage buffer ----------------------------------------------------

local buf
local sessions = {}
local summaries = {} -- session id -> summary, rebuilt when its logs change
local warmed = {} -- cwd -> true once its logs were read, false while reading (warm)
local cards, labels = {}, {} -- by_card's, as of the last push
local costs_seen -- card_costs as of the last push, to notice a change
local line_session = {} -- line number -> session id
local selected
local period = "week"
local sort = "recent"
-- Pepper's usage-recommendations note as last fetched, and whether the
-- view shows it in place of the selected session.
local advice
local show_advice = false

local function period_of(key)
  for i, p in ipairs(PERIODS) do
    if p.key == key then return p, i end
  end
end

local function human(n)
  n = n or 0
  if n >= 1e6 then return string.format("%.1fM", n / 1e6) end
  if n >= 1e3 then return string.format("%.0fk", n / 1e3) end
  return tostring(math.floor(n))
end

local function dollars(n)
  return n and string.format("$%.2f", n) or "—"
end

local function ago(timestamp)
  local y, mo, d, h, mi, s = tostring(timestamp or ""):match("(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
  if not y then return "" end
  local utc = os.time({ year = y, month = mo, day = d, hour = h, min = mi, sec = s })
  -- os.time reads the table as local time; undo the zone offset.
  local now = os.time()
  local offset = os.difftime(now, os.time(os.date("!*t", now)))
  local secs = now - (utc + offset)
  if secs < 90 then return "now" end
  if secs < 3600 then return math.floor(secs / 60) .. "m ago" end
  if secs < 86400 then return math.floor(secs / 3600) .. "h ago" end
  return math.floor(secs / 86400) .. "d ago"
end

local function model_name(id)
  if not id then return "" end
  local family, major, minor = id:match("^claude%-(%a+)%-(%d+)%-?(%d?)")
  if not family then return id end
  return family:sub(1, 1):upper() .. family:sub(2) .. " " .. major .. (minor ~= "" and ("." .. minor) or "")
end

local function total(t)
  return t.input + t.write + t.read + t.output
end

local function summary_of(session)
  local s = summaries[session.id]
  if s then
    s.ago = ago(s.updated) -- kept until its logs grow, so only this goes stale
    return s
  end
  local price = transcript.prices(session)
  s = transcript.summarize(session.log, price)
  s.id = session.id
  s.title = session.log.title or session.id:sub(1, 8)
  s.updated = session.log.updated
  s.ago = ago(session.log.updated)
  s.session_cost = session.log.cost and session.log.cost.totalCostUSD
  s.agents = {}
  for _, a in ipairs(session.agents) do
    local as = transcript.summarize(a, price)
    as.type = a.meta.agentType or "agent"
    as.description = a.meta.description or ""
    as.categories, as.series = nil, nil
    table.insert(s.agents, as)
  end
  table.sort(s.agents, function(a, b) return total(a.tokens) > total(b.tokens) end)
  summaries[session.id] = s
  return s
end

-- A session's cost for sorting and totals: its own record, else the estimate
-- from its tokens.
local function cost_of(s)
  return s.session_cost or s.cost
end

local function sort_sessions()
  if sort ~= "cost" then return end -- scan() lists them newest first
  local cost = {}
  for _, session in ipairs(sessions) do cost[session] = cost_of(summary_of(session)) or -1 end
  table.sort(sessions, function(a, b) return cost[a] > cost[b] end)
end

local function period_total()
  local sum = 0
  for _, session in ipairs(sessions) do sum = sum + (cost_of(summary_of(session)) or 0) end
  return sum
end

local function state()
  local list = {}
  for _, session in ipairs(sessions) do
    local s = summary_of(session)
    if s.id == selected then
      table.insert(list, s)
    else
      -- Only the selected session's breakdown goes to the browser.
      table.insert(list, {
        id = s.id, title = s.title, ago = s.ago, model = s.model, requests = s.requests,
        tokens = s.tokens, cost = s.cost, session_cost = s.session_cost, context = s.context,
      })
    end
  end
  local periods = {}
  for _, p in ipairs(PERIODS) do table.insert(periods, { key = p.key, label = p.label }) end
  return {
    root = vim.fn.getcwd(), selected = selected, sessions = list,
    loading = warmed[vim.fn.getcwd()] ~= true or nil,
    period = period, periods = periods, sort = sort, total = period_total(),
    advice = advice and { body = advice.body, updated = advice.updated } or nil, show_advice = show_advice,
    cards = cards, labels = labels,
  }
end

local function push_state()
  require("corkboard").notify("corkboard.usage", state())
end

local function render_text()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local lines, map = { "Token usage  " .. vim.fn.getcwd(), "" }, {}
  table.insert(lines, string.format("SESSIONS (%d) · %s · by %s · %s      p period · s sort", #sessions,
    period == "all" and "all time" or ("last " .. period_of(period).label), sort, dollars(period_total())))
  for _, session in ipairs(sessions) do
    local s = summary_of(session)
    table.insert(lines, string.format("  %-7s %-40s %8s %7s  %s", s.ago, short(s.title, 40),
      dollars(s.session_cost), human(total(s.tokens)), model_name(s.model)))
    map[#lines] = s.id
  end
  if #sessions == 0 then
    if warmed[vim.fn.getcwd()] ~= true then
      table.insert(lines, "  reading session logs…")
    else
      table.insert(lines, "  — no Claude Code sessions in " .. project_dir(vim.fn.getcwd())
        .. (period ~= "all" and (" in the last " .. period_of(period).label) or ""))
    end
  end
  if #cards > 0 then
    vim.list_extend(lines, { "", "BY CARD (agents corkboard started; all time)" })
    for _, c in ipairs(cards) do
      table.insert(lines, string.format("  %-9s %-40s %8s %7s  %d session%s", c.id, short(c.title, 40),
        dollars(c.cost), human(c.tokens), c.sessions, c.sessions == 1 and "" or "s"))
    end
    table.insert(lines, "  by label: " .. table.concat(vim.tbl_map(function(l)
      return string.format("%s %s (%d)", l.label, dollars(l.cost), l.cards)
    end, labels), " · "))
  end

  local s
  for _, session in ipairs(sessions) do
    if session.id == selected then s = summary_of(session) end
  end
  if not s and sessions[1] then -- none yet, or it fell off the list: the newest
    s = summary_of(sessions[1])
    selected = s.id
  end
  if s then
    local t = s.tokens
    vim.list_extend(lines, {
      "",
      string.format("%s  ·  %d requests  ·  context %s", s.title, s.requests, human(s.context)),
      string.format("  input: %.1f%% cached · %s cache reads · %s cache writes (%s 1h) · %s uncached",
        s.cache.hit * 100, human(t.read), human(t.write), human(t.write_1h), human(t.input)),
      string.format("  output %s (thinking %s) · %d cache misses re-sent %s",
        human(t.output), human(t.thinking), #s.cache.misses, human(s.cache.miss_tokens)),
      "",
      "WHERE IT WENT                     count  written uncached cache-read  share     cost",
    })
    for _, c in ipairs(s.categories) do
      table.insert(lines, string.format("  %-28s %6d× %8s %8s %10s %5.1f%% %8s", c.label, c.count,
        human(c.written), human(c.uncached), human(c.read), c.share * 100, c.cost and dollars(c.cost) or ""))
    end
    if #s.cache.misses > 0 then
      table.insert(lines, "")
      table.insert(lines, "CACHE MISSES")
      for _, m in ipairs(s.cache.misses) do
        table.insert(lines, string.format("  %-58s %8s re-sent %8s", short(m.label, 58), human(m.tokens), m.cost and dollars(m.cost) or ""))
      end
    end
    table.insert(lines, "")
    table.insert(lines, "HEAVIEST ITEMS")
    for _, it in ipairs(s.top) do
      table.insert(lines, string.format("  %-52s %7s × %4d reads %5.1f%%", short(it.label, 52), human(it.size), it.reads, it.share * 100))
    end
    if #s.agents > 0 then
      table.insert(lines, "")
      table.insert(lines, "SUBAGENTS")
      for _, a in ipairs(s.agents) do
        table.insert(lines, string.format("  %-14s %-40s %7s %8s", a.type, short(a.description, 40), human(total(a.tokens)), dollars(a.cost)))
      end
    end
  end

  pinned.set_lines(buf, lines)
  line_session = map
  -- Keep the cursor on the selected session as the list reorders.
  pinned.follow(buf, line_session, selected)
end

-- Pepper's report -------------------------------------------------------------
--
-- The last week of this project's sessions, as a note on the Worker
-- (usage-<project>, kind review) that Pepper reads to suggest how to spend
-- fewer tokens. Sent once the logs are read, then hourly when it changed.
-- Absolute times only, so an unchanged week sends nothing.

local REPORT_DAYS = 7

local function pct(x) return string.format("%.0f%%", (x or 0) * 100) end
local function when(timestamp) return (tostring(timestamp or ""):sub(1, 16):gsub("T", " ")) .. "Z" end

function M.report(cwd)
  local list = scan(cwd, os.time() - REPORT_DAYS * 86400)
  if #list == 0 then return nil end
  local sums = { cost = 0, tokens = 0, requests = 0, read = 0, sent = 0, misses = 0, miss_tokens = 0, miss_cost = 0 }
  local by_label, by_agent, by_model = {}, {}, {}
  local rows = {}
  for _, session in ipairs(list) do
    local s = summary_of(session)
    local cost = cost_of(s) or 0
    local t = s.tokens
    sums.cost = sums.cost + cost
    sums.tokens = sums.tokens + total(t)
    sums.requests = sums.requests + s.requests
    sums.read = sums.read + t.read
    sums.sent = sums.sent + t.read + t.write + t.input
    sums.misses = sums.misses + #s.cache.misses
    sums.miss_tokens = sums.miss_tokens + s.cache.miss_tokens
    for _, m in ipairs(s.cache.misses) do sums.miss_cost = sums.miss_cost + (m.cost or 0) end
    for _, c in ipairs(s.categories or {}) do
      local l = by_label[c.label] or { label = c.label, cost = 0, count = 0, sessions = 0 }
      l.cost, l.count, l.sessions = l.cost + (c.cost or 0), l.count + c.count, l.sessions + 1
      by_label[c.label] = l
    end
    for _, a in ipairs(s.agents) do
      local g = by_agent[a.type] or { type = a.type, cost = 0, runs = 0 }
      g.cost, g.runs = g.cost + (a.cost or 0), g.runs + 1
      by_agent[a.type] = g
    end
    local model = model_name(s.model)
    by_model[model] = (by_model[model] or 0) + cost
    table.insert(rows, { s = s, cost = cost })
  end
  local function sorted(t, key)
    local out = vim.tbl_values(t)
    table.sort(out, function(a, b) return a[key] > b[key] end)
    return out
  end

  local lines = {
    string.format("# Token usage: %s, the %d days to %s", cwd, REPORT_DAYS, os.date("!%Y-%m-%d")),
    "",
    "From corkboard's usage view (Claude Code's session logs). Costs are list-price estimates; a session's cost is",
    "its own record where it has one. Cache hit: the share of input read from the prompt cache. A miss is a request",
    "that sent an already-sent context again, usually after the cache expired while the session sat idle.",
    "",
    "## Totals",
    "",
    string.format("- %d sessions, %d requests, %s tokens, %s", #list, sums.requests, human(sums.tokens), dollars(sums.cost)),
    string.format("- cache hit %s; %d misses re-sent %s tokens, %s", pct(sums.sent > 0 and sums.read / sums.sent or 0),
      sums.misses, human(sums.miss_tokens), dollars(sums.miss_cost)),
  }
  local models = {}
  for name, cost in pairs(by_model) do
    if cost >= 0.005 then table.insert(models, { name = name ~= "" and name or "unknown", cost = cost }) end
  end
  table.sort(models, function(a, b) return a.cost > b.cost end)
  table.insert(lines, "- by model: " .. table.concat(vim.tbl_map(function(m) return m.name .. " " .. dollars(m.cost) end, models), ", "))

  vim.list_extend(lines, { "", "## What the context was spent on", "", "Across all sessions; cost is writing and re-reading it.", "" })
  for i, l in ipairs(sorted(by_label, "cost")) do
    if i > 12 then break end
    table.insert(lines, string.format("- %s: %s (%d items, in %d sessions)", l.label, dollars(l.cost), l.count, l.sessions))
  end

  local agents = sorted(by_agent, "cost")
  if #agents > 0 then
    vim.list_extend(lines, { "", "## Subagents", "" })
    for _, g in ipairs(agents) do
      table.insert(lines, string.format("- %s: %d runs, %s", g.type, g.runs, dollars(g.cost)))
    end
  end

  table.sort(rows, function(a, b) return a.cost > b.cost end)
  vim.list_extend(lines, { "", "## The costliest sessions", "" })
  for i, r in ipairs(rows) do
    if i > 10 then break end
    local s = r.s
    local peak = 0
    for _, v in ipairs(s.series or {}) do peak = math.max(peak, v) end
    vim.list_extend(lines, {
      string.format("### %s", s.title),
      "",
      string.format("- %s, last active %s, %s, %d requests, peak context %s", dollars(r.cost), when(s.updated),
        model_name(s.model), s.requests, human(peak)),
      string.format("- cache hit %s, %d misses (%s tokens)", pct(s.cache.hit), #s.cache.misses, human(s.cache.miss_tokens)),
    })
    local cats = {}
    for j, c in ipairs(s.categories or {}) do
      if j > 4 then break end
      table.insert(cats, string.format("%s %s", c.label, pct(c.share)))
    end
    if #cats > 0 then table.insert(lines, "- spent on: " .. table.concat(cats, ", ")) end
    local top = {}
    for j, it in ipairs(s.top or {}) do
      if j > 3 then break end
      table.insert(top, string.format("%s (%s, %s tokens, read %d times)", short(it.label, 60), it.kind, human(it.size), it.reads))
    end
    if #top > 0 then table.insert(lines, "- heaviest items: " .. table.concat(top, "; ")) end
    if #s.agents > 0 then
      table.insert(lines, "- subagents: " .. table.concat(vim.tbl_map(function(a)
        return string.format("%s %s", a.type, dollars(a.cost))
      end, s.agents), ", "))
    end
    table.insert(lines, "")
  end
  return table.concat(lines, "\n")
end

local published = {} -- cwd -> the report last sent

local function note_id(cwd)
  return (("usage-" .. cwd:lower():gsub("[^a-z0-9]+", "-"):gsub("^-+", ""):gsub("-+$", "")):sub(1, 80):gsub("-+$", ""))
end

local function publish(cwd)
  local cloud = require("corkboard.cards.cloud")
  if not cloud.enabled() or cwd == vim.uv.os_homedir() or require("corkboard").window == "plan" then return end
  local ok, text = pcall(M.report, cwd)
  if not ok or not text or published[cwd] == text then return end
  local sent, err = pcall(cloud.note_put, note_id(cwd), { kind = "review", title = "Usage: " .. vim.fs.basename(cwd), body = text })
  if sent then
    published[cwd] = text
  else
    vim.notify("corkboard: sending the usage report: " .. tostring(err), vim.log.levels.WARN)
  end
end

-- Pepper's answer to the report (its daily review in pepper-vm).
local function fetch_advice()
  local cloud = require("corkboard.cards.cloud")
  if not cloud.enabled() then return end
  local ok, note = pcall(cloud.note_get, "usage-recommendations")
  if not ok or type(note) ~= "table" or (advice and advice.updated == note.updated) then return end
  advice = note
  push_state()
end

-- Show Pepper's advice (on true), the selected session (false), or the
-- other one (nil).
function M.show_advice(on)
  if on == nil then on = not show_advice end
  show_advice = on
  push_state()
  if on then vim.schedule(fetch_advice) end
end

local hourly
local function publish_hourly(cwd)
  hourly = hourly or assert(vim.uv.new_timer())
  if not hourly:is_active() then
    hourly:start(3600 * 1000, 3600 * 1000, vim.schedule_wrap(function()
      publish(vim.fn.getcwd())
      fetch_advice()
    end))
  end
  vim.schedule(function()
    publish(cwd)
    fetch_advice()
  end)
end

-- The first read of a project's logs parses every one of them, most of a
-- second for a busy project. It happens a log per tick, so Neovim stays
-- responsive; until it's done the view says it is reading, and push()
-- leaves the logs alone.
local function warm(cwd)
  warmed[cwd] = false
  local paths = {}
  local dir = project_dir(cwd)
  if vim.fn.isdirectory(dir) == 1 then
    for name, kind in vim.fs.dir(dir, { depth = 3 }) do
      if kind == "file" and name:match("%.jsonl$") then table.insert(paths, vim.fs.joinpath(dir, name)) end
    end
  end
  for _, list in pairs(require("corkboard.agents").card_sessions()) do
    for _, s in ipairs(list) do
      if s.transcript then table.insert(paths, s.transcript) end
    end
  end
  local i = 0
  local function step()
    i = i + 1
    if paths[i] then
      pcall(transcript.read, paths[i], cwd)
      return vim.defer_fn(step, 0)
    end
    warmed[cwd] = true
    if vim.fn.getcwd() == cwd then M.push(true) end
    publish_hourly(cwd)
  end
  vim.defer_fn(step, 0)
end

-- Re-read the logs; redraw and push when anything changed (or force).
function M.push(force)
  local cwd = vim.fn.getcwd()
  if not warmed[cwd] then
    if warmed[cwd] == nil then warm(cwd) end
    sessions, cards, labels, M.cwd = {}, {}, {}, nil
    render_text()
    push_state()
    return
  end
  local p = period_of(period)
  local changed
  sessions, changed = scan(cwd, p.secs and os.time() - p.secs)
  force = force or M.cwd ~= cwd
  if force then summaries = {} end
  for _, session in ipairs(sessions) do
    if session.grew then summaries[session.id] = nil end
  end
  M.cwd = cwd
  -- A session can also age out of the period without any log growing.
  changed = changed or #sessions ~= M.count
  M.count = #sessions
  -- Cards' sessions are elsewhere (see card_costs), so they're compared.
  local costs = M.card_costs()
  local key = vim.json.encode(costs)
  if key ~= costs_seen or force then
    costs_seen = key
    cards, labels = by_card(costs)
    changed = true
  end
  sort_sessions()
  if changed or force then
    render_text()
    push_state()
  end
end

-- Show the sessions of another period ("day", "week", "month", "all"), or
-- the next one when key is nil.
function M.set_period(key)
  local _, i = period_of(period)
  period = period_of(key) and key or PERIODS[i % #PERIODS + 1].key
  M.push(true)
end

-- List by "recent" or "cost", or the other one when key is nil.
function M.set_sort(key)
  sort = SORTS[key] or (sort == "cost" and "recent" or "cost")
  M.push(true)
end

-- A click on a session in the browser.
function M.select(id, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(line_session, id)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
end

-- While the view is in sight, look for new log lines every two seconds. A
-- poll rather than a watcher: subagents write a directory further down, and
-- a read that finds nothing new is one stat per log.
local timer

local function tick()
  local wins = buf and vim.api.nvim_buf_is_valid(buf) and vim.fn.win_findbuf(buf) or {}
  if #wins == 0 then return timer:stop() end
  local tab = vim.api.nvim_get_current_tabpage()
  for _, win in ipairs(wins) do
    if vim.api.nvim_win_get_tabpage(win) == tab then return M.push() end
  end
end

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  timer = timer or assert(vim.uv.new_timer())
  buf = pinned.listing("agent://usage", "usage", {
    j = { function() pinned.step(line_session, 1) end, "next session" },
    k = { function() pinned.step(line_session, -1) end, "previous session" },
    ["<Down>"] = { function() pinned.step(line_session, 1) end, "next session" },
    ["<Up>"] = { function() pinned.step(line_session, -1) end, "previous session" },
    R = { function()
      M.push(true)
      vim.schedule(fetch_advice)
    end, "refresh" },
    a = { function() M.show_advice() end, "Pepper's advice / the session" },
    p = { function() M.set_period() end, "next period" },
    s = { function() M.set_sort() end, "sort by recent/cost" },
  }, function() return line_session end, function(id)
    if id == selected then return end
    selected = id
    render_text()
    push_state()
  end)
  vim.api.nvim_create_autocmd("BufWinEnter", {
    buffer = buf,
    callback = function()
      if not timer:is_active() then timer:start(2000, 2000, vim.schedule_wrap(tick)) end
    end,
  })
  -- Back on the tab: what changed while it was out of sight.
  vim.api.nvim_create_autocmd("BufEnter", { buffer = buf, callback = function() M.push() end })
  return buf
end

-- Keep the usage view second among the tabs, after the board. Leaves focus
-- where it was.
function M.ensure()
  if pinned.ensure("corkboard_usage", 2, buffer()) then M.push(true) end
end

function M.show()
  M.ensure()
  pinned.show("corkboard_usage", 2, buffer())
  M.push(true)
end

-- For a channel that just attached: the last state again, if the view exists.
function M.push_all()
  if buf and vim.api.nvim_buf_is_valid(buf) then push_state() end
end

return M
