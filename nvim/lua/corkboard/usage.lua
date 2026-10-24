-- Token use of the Claude Code sessions in this project, and what it went on.
--
-- Claude Code logs every session to ~/.claude/projects/<cwd with every
-- non-alphanumeric as ->/<session>.jsonl, and each subagent to
-- <session>/subagents/agent-<id>.jsonl beside a .meta.json naming its type.
-- An assistant record carries the API usage of the request that produced
-- it; one response is split over several records that repeat the same
-- usage, so requests are counted once per message id.
--
-- Attribution: a request's new tokens (input + cache writes) are whatever
-- joined the context since the request before it: tool results, prompts,
-- reminders, the previous reply. The real count is split between those
-- items by their estimated sizes (bytes / 4), so the estimate only decides
-- shares, never totals. Each item is then read back from the cache by
-- every later request until a compaction drops it, which is where most of
-- the tokens go: a 10k-token file read early in a 200-request session costs
-- about 2M cache reads.
--
-- Cost: requests are weighed in input-token units (cache read 0.1, input 1,
-- 5-minute cache write 1.25, 1-hour write 2, output 5, the ratios on every
-- Claude model), and the session's own costUSD per model (its cost-state
-- record, which includes its subagents) prices a unit. Sessions without one
-- show tokens only.
--
-- The view is the agent://usage buffer: a plain listing, with the browser's
-- HTML drawn over it like the board. The selected session is the one the
-- cursor's line belongs to. The list shows the sessions active in a period
-- (a log written to within it), newest first or by cost.

local M = {}

local W = { read = 0.1, input = 1, write_5m = 1.25, write_1h = 2, output = 5 }

local KINDS = {
  system = "System prompt & tools",
  user = "Your messages",
  reminders = "Reminders & attachments",
  thinking = "Thinking",
  text = "Claude's replies",
  compact = "Compaction summaries",
  rebuild = "Cache misses (re-sent)",
  other = "Not in the log",
}

-- Claude's own output: generated, then part of the context from the next
-- request on.
local function is_output(kind)
  return kind == "thinking" or kind == "text" or kind:match("^call:") ~= nil
end

-- Attachments that are the system prompt or the tool list rather than a
-- reminder injected into the conversation.
local SYSTEM_ATTACHMENTS = { prompt_snapshot = true, deferred_tools_record = true, skill_listing = true }

-- The periods `p` cycles through. A session counts when its log was last
-- written within the period; its cost is still the whole session's.
local PERIODS = {
  { key = "day", label = "24h", secs = 86400 },
  { key = "week", label = "7d", secs = 7 * 86400 },
  { key = "month", label = "30d", secs = 30 * 86400 },
  { key = "all", label = "all" },
}
local SORTS = { recent = "recent", cost = "cost" }

local function config_dir()
  return vim.env.CLAUDE_CONFIG_DIR or vim.fs.joinpath(vim.uv.os_homedir(), ".claude")
end

local function project_dir(cwd)
  return vim.fs.joinpath(config_dir(), "projects", (cwd:gsub("[^%w]", "-")))
end

-- Parsing ---------------------------------------------------------------------

local function new_log(path)
  return {
    path = path,
    offset = 0,
    rest = "", -- an unfinished last line, kept for the next read
    seen = {}, -- message id -> true
    tools = {}, -- tool_use id -> { name, detail }
    pending = {}, -- items added since the last request
    live = {}, -- items in the context
    items = {},
    n = 0, -- requests
    prev_context = 0,
    tokens = { input = 0, write = 0, read = 0, output = 0, thinking = 0, write_1h = 0 },
    misses = {}, -- cache misses, as their rebuild items
    units = {}, -- model -> input-token units
    series = {}, -- context size per request
  }
end

local function text_size(content)
  if type(content) == "string" then return #content / 4 end
  if type(content) ~= "table" then return 0 end
  local n = 0
  for _, c in ipairs(content) do
    if type(c) ~= "table" then
      n = n + #tostring(c) / 4
    elseif c.type == "image" then
      n = n + 1600 -- about a 1200×1000 image; the real count corrects the share
    elseif c.type == "document" then
      n = n + #(vim.tbl_get(c, "source", "data") or "") / 40
    elseif c.text then
      n = n + #c.text / 4
    elseif c.content then
      n = n + text_size(c.content)
    end
  end
  return n
end

local function short(s, n)
  s = tostring(s or ""):gsub("%s+", " ")
  return #s > n and s:sub(1, n - 1) .. "…" or s
end

local function relative(path, cwd)
  if type(path) ~= "string" then return nil end
  if cwd and path:sub(1, #cwd + 1) == cwd .. "/" then return path:sub(#cwd + 2) end
  return vim.fn.fnamemodify(path, ":~")
end

-- What a tool call was about, for the heaviest-items list.
local function tool_detail(name, input, cwd)
  if type(input) ~= "table" then return "" end
  local d = relative(input.file_path or input.notebook_path or input.path, cwd)
    or input.description or input.command or input.pattern or input.url or input.query
    or input.prompt or input.skill
  if not d then
    for _, v in pairs(input) do
      if type(v) == "string" then d = v break end
    end
  end
  return short(d, 70)
end

local function add(log, kind, label, est)
  if est <= 0 then return end
  local item = { kind = kind, label = label, est = est }
  table.insert(log.pending, item)
  return item
end

-- The last response's blocks, once all its records are in: its output
-- tokens split between thinking (counted exactly) and the text and tool
-- calls (by size), each billed as output and pending for the next request.
local function flush_reply(log)
  local reply = log.reply
  if not reply then return end
  log.reply = nil
  local est = 0
  for _, part in ipairs(reply.parts) do est = est + part.est end
  local rest = math.max(0, reply.output - reply.thinking)
  if reply.thinking > 0 then
    add(log, "thinking", "Thinking, request " .. reply.n, reply.thinking).gen = reply.thinking * W.output
  end
  if est == 0 then
    if rest > 0 then add(log, "text", "Reply to request " .. reply.n, rest).gen = rest * W.output end
    return
  end
  for _, part in ipairs(reply.parts) do
    local tokens = rest * part.est / est
    local item = add(log, part.kind, part.label, tokens)
    if item then item.gen = tokens * W.output end
  end
end

-- Seconds since the epoch, near enough: only differences are used.
local function seconds(timestamp)
  local y, mo, d, h, mi, s = tostring(timestamp or ""):match("(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
  return y and os.time({ year = y, month = mo, day = d, hour = h, min = mi, sec = s }) or nil
end

local function duration(secs)
  if not secs then return "?" end
  if secs < 90 then return math.floor(secs) .. "s" end
  if secs < 5400 then return math.floor(secs / 60 + 0.5) .. "m" end
  return string.format("%.1fh", secs / 3600)
end

-- A request's input arrives three ways: read from the cache (cheap), written
-- to it (new content, dearer than plain input), or sent uncached. Each item
-- keeps how its own tokens arrived, from the request that first sent it.
local function request(log, msg, timestamp)
  flush_reply(log)
  local u = msg.usage or {}
  local input = u.input_tokens or 0
  local write = u.cache_creation_input_tokens or 0
  local read = u.cache_read_input_tokens or 0
  local output = u.output_tokens or 0
  log.n = log.n + 1
  local n = log.n
  local model = msg.model or "?"
  log.model = model

  local t = log.tokens
  t.input, t.write, t.read, t.output = t.input + input, t.write + write, t.read + read, t.output + output
  t.thinking = t.thinking + (vim.tbl_get(u, "output_tokens_details", "thinking_tokens") or 0)
  local w1h = vim.tbl_get(u, "cache_creation", "ephemeral_1h_input_tokens") or 0
  t.write_1h = t.write_1h + w1h
  local units = input * W.input + (write - w1h) * W.write_5m + w1h * W.write_1h + read * W.read + output * W.output
  log.units[model] = (log.units[model] or 0) + units
  -- Units per new token, and its split into cache writes and uncached input.
  local new = input + write
  local wunit = new > 0 and (input * W.input + (write - w1h) * W.write_5m + w1h * W.write_1h) / new or 1
  local wshare = new > 0 and write / new or 0

  local context = input + write + read
  table.insert(log.series, context)

  local function place(item, size)
    item.size, item.from, item.model, item.wunit = size, n, model, wunit
    item.written, item.uncached = size * wshare, size * (1 - wshare)
    table.insert(log.items, item)
  end

  -- Less read back than the last request had: a cache miss. Usually the
  -- cache expired (5 minutes or 1 hour after it was last read) while the
  -- session sat idle, and the context was sent again, written or uncached.
  local remaining = new
  local now = seconds(timestamp)
  local missed = math.min(remaining, log.prev_context - read)
  -- A context that shrank re-sends nothing (missed is 0); that is no miss.
  if log.n > 1 and not log.compacted and read < log.prev_context * 0.9 - 2000 and missed > 1000 then
    local idle = now and log.prev_time and now - log.prev_time
    local why = idle and idle >= (log.prev_ttl == "1h" and 3600 or 300) and ("idle " .. duration(idle) .. ", cache expired")
      or "cache evicted or prefix changed"
    local item = { kind = "rebuild", label = string.format("Miss at request %d (%s)", n, why), reads = 0 }
    place(item, missed)
    item.idle, item.ttl = idle, log.prev_ttl
    table.insert(log.misses, item)
    remaining = remaining - missed
  end
  log.compacted = false
  log.prev_time = now or log.prev_time
  -- The TTL the context was last cached with, for telling an expiry from
  -- an eviction.
  if write > 0 then log.prev_ttl = w1h > 0 and "1h" or "5m" end

  -- Bytes / 4 undercounts code, so estimates may scale up, but only so far:
  -- past twice the estimate the rest is something the log never shows
  -- (the system prompt on the first request).
  local est = 0
  for _, item in ipairs(log.pending) do est = est + item.est end
  local scale = est > 0 and math.min(remaining / est, n == 1 and 1 or 2) or 0
  for _, item in ipairs(log.pending) do
    place(item, item.est * scale)
    table.insert(log.live, item)
  end
  local extra = remaining - est * scale
  if extra > 1 then
    local kind = n == 1 and "system" or "other"
    local item = { kind = kind, label = n == 1 and "System prompt, tools, memory" or "Not in the log" }
    place(item, extra)
    table.insert(log.live, item)
  end
  log.pending = {}
  log.prev_context = context

  log.reply = {
    id = msg.id,
    n = n,
    output = output,
    thinking = vim.tbl_get(u, "output_tokens_details", "thinking_tokens") or 0,
    parts = {},
  }
end

local function record(log, r, cwd)
  if r.type == "assistant" and type(r.message) == "table" then
    local msg = r.message
    if msg.id and not log.seen[msg.id] and msg.usage then
      log.seen[msg.id] = true
      request(log, msg, r.timestamp)
    end
    local reply = log.reply and log.reply.id == msg.id and log.reply
    for _, c in ipairs(type(msg.content) == "table" and msg.content or {}) do
      if c.type == "tool_use" then
        local detail = tool_detail(c.name, c.input, cwd)
        log.tools[c.id] = { name = c.name, detail = detail }
        if reply then
          local size = #vim.json.encode(c.input or {}) / 4
          table.insert(reply.parts, { kind = "call:" .. c.name, label = c.name .. " call " .. detail, est = size })
        end
      elseif c.type == "text" and reply then
        table.insert(reply.parts, { kind = "text", label = short(c.text, 70), est = #(c.text or "") / 4 })
      end
    end
  elseif r.type == "user" and type(r.message) == "table" then
    local content = r.message.content
    if r.isCompactSummary then
      add(log, "compact", "Compaction summary", text_size(content))
    elseif type(content) == "string" then
      add(log, r.isMeta and "reminders" or "user", short(content, 70), #content / 4)
    elseif type(content) == "table" then
      for _, c in ipairs(content) do
        if c.type == "tool_result" then
          local tool = log.tools[c.tool_use_id] or { name = "?", detail = "" }
          add(log, "tool:" .. tool.name, tool.name .. " " .. tool.detail, text_size(c.content))
        elseif c.type == "text" then
          add(log, r.isMeta and "reminders" or "user", short(c.text, 70), #c.text / 4)
        else
          add(log, "user", c.type, text_size({ c }))
        end
      end
    end
  elseif r.type == "attachment" and type(r.attachment) == "table" then
    local kind = SYSTEM_ATTACHMENTS[r.attachment.type] and "system" or "reminders"
    add(log, kind, tostring(r.attachment.type):gsub("_", " ") .. " (attachment)", #vim.json.encode(r.attachment) / 4)
  elseif r.type == "system" and r.subtype == "compact_boundary" then
    for _, item in ipairs(log.live) do item.to = log.n end
    log.live, log.pending, log.compacted = {}, {}, true
  elseif r.type == "ai-title" then
    log.title = r.aiTitle
  elseif r.type == "cost-state" then
    log.cost = r
  end
  if r.timestamp then log.updated = r.timestamp end
end

-- Read what was appended since last time. True when anything was.
local function update(log, cwd)
  local stat = vim.uv.fs_stat(log.path)
  if not stat then return false end
  if stat.size < log.offset then -- rewritten from the start
    local fresh = new_log(log.path)
    for k in pairs(log) do log[k] = nil end
    for k, v in pairs(fresh) do log[k] = v end
  end
  log.mtime = stat.mtime.sec
  if stat.size == log.offset then return false end
  local fd = vim.uv.fs_open(log.path, "r", 0)
  if not fd then return false end
  local data = vim.uv.fs_read(fd, stat.size - log.offset, log.offset)
  vim.uv.fs_close(fd)
  if not data then return false end
  log.offset = log.offset + #data
  data = log.rest .. data
  local start = 1
  while true do
    local nl = data:find("\n", start, true)
    if not nl then break end
    local ok, r = pcall(vim.json.decode, data:sub(start, nl - 1), { luanil = { object = true, array = true } })
    if ok and type(r) == "table" then record(log, r, cwd) end
    start = nl + 1
  end
  log.rest = data:sub(start)
  return true
end

-- Sessions --------------------------------------------------------------------

local logs = {} -- path -> log, kept across refreshes so reads stay incremental

local function log_for(path, cwd)
  logs[path] = logs[path] or new_log(path)
  local log = logs[path]
  return log, update(log, cwd)
end

local function read_meta(path)
  local ok, lines = pcall(vim.fn.readfile, path)
  if not ok then return {} end
  local ok2, meta = pcall(vim.json.decode, table.concat(lines, "\n"))
  return ok2 and type(meta) == "table" and meta or {}
end

-- The sessions in this project written to since `since` (any, when nil),
-- newest first, each with its subagents and whether any of its logs grew.
-- Changed is true when any log grew.
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
    local log, grew = log_for(f.path, cwd)
    local session = { id = f.id, log = log, agents = {}, grew = grew }
    local sub = vim.fs.joinpath(dir, f.id, "subagents")
    if vim.fn.isdirectory(sub) == 1 then
      for name, kind in vim.fs.dir(sub) do
        if kind == "file" and name:match("%.jsonl$") then
          local alog, agrew = log_for(vim.fs.joinpath(sub, name), cwd)
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
-- What each card's agents cost, from the sessions corkboard.agents started
-- on it (sessions.json beside the board). Those run in worktrees, so their
-- logs are under other project directories, out of scan()'s sight; they are
-- read by path instead. A session's cost is its cost-state's total
-- (subagents included); tokens are its own log's.

-- id -> { cost (nil while no session has a cost-state), tokens, sessions,
-- today (the cost of sessions started since local midnight) }
function M.card_costs()
  local out = {}
  local midnight = os.time(vim.tbl_extend("force", os.date("*t"), { hour = 0, min = 0, sec = 0 }))
  for id, list in pairs(require("corkboard.agents").card_sessions()) do
    local c = { tokens = 0, sessions = 0, today = 0 }
    for _, s in ipairs(list) do
      if s.transcript and vim.uv.fs_stat(s.transcript) then
        local log = log_for(s.transcript, vim.fn.getcwd())
        c.sessions = c.sessions + 1
        c.tokens = c.tokens + log.tokens.input + log.tokens.write + log.tokens.read + log.tokens.output
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

-- The cards with costs, most expensive first, and the same added up by
-- label (a card with two labels counts in both).
local function by_card()
  local costs = M.card_costs()
  if vim.tbl_isempty(costs) then return {}, {} end
  local cards, labels = {}, {}
  for _, card in ipairs(require("corkboard.board").list()) do
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

-- Summaries -------------------------------------------------------------------

-- Dollars per input-token unit for each model, from the session's
-- cost-state over the units seen in it and its subagents.
local function prices(session)
  local cost = session.log.cost
  if not (cost and type(cost.modelUsage) == "table") then return nil end
  local units = {}
  for _, log in ipairs(vim.list_extend({ session.log }, session.agents)) do
    for model, u in pairs(log.units) do units[model] = (units[model] or 0) + u end
  end
  -- The cost-state names a variant ("claude-opus-5[1m]") where messages
  -- name the model ("claude-opus-5").
  local by_model, all_cost, all_units = {}, 0, 0
  for model, use in pairs(cost.modelUsage) do
    local base = model:gsub("%[.-%]$", "")
    by_model[base] = (by_model[base] or 0) + (use.costUSD or 0)
  end
  local price = {}
  for model, u in pairs(units) do
    all_units = all_units + u
    if by_model[model] and u > 0 then price[model] = by_model[model] / u end
  end
  for _, c in pairs(by_model) do all_cost = all_cost + c end
  -- Anything still unmatched is priced at the session's average.
  return setmetatable(price, { __index = function() return all_units > 0 and all_cost / all_units or nil end })
end

-- Each item's tokens written, cache reads and units. Reads are scaled so
-- they add up to the log's real cache reads.
-- The last reply has been generated (and billed) but no request has read
-- it yet, so it is counted for its output alone.
local function weigh(log)
  flush_reply(log)
  local items = vim.list_extend({}, log.items)
  for _, item in ipairs(log.pending) do
    if item.gen then
      item.size, item.from, item.model, item.wunit, item.written, item.uncached = 0, log.n, log.model, 0, 0, 0
      table.insert(items, item)
    end
  end
  local est = 0
  for _, item in ipairs(items) do
    item.reads = item.kind == "rebuild" and 0 or ((item.to or log.n) - item.from)
    est = est + item.size * item.reads
  end
  local scale = est > 0 and log.tokens.read / est or 0
  for _, item in ipairs(items) do
    item.read_tokens = item.size * item.reads * scale
    item.units = item.size * item.wunit + item.read_tokens * W.read + (item.gen or 0)
  end
  return items
end

local function label_of(kind)
  if KINDS[kind] then return KINDS[kind] end
  local call = kind:match("^call:(.*)")
  if call then return call .. " calls" end
  return (kind:match("^tool:(.*)") or kind) .. " results"
end

local function summarize(log, price)
  local all = weigh(log)
  local function usd(units, model)
    local p = price and (price[model] or price[log.model])
    return p and units * p or nil
  end

  local by, total_units = {}, 0
  for _, item in ipairs(all) do
    local c = by[item.kind]
    if not c then
      c = { kind = item.kind, label = label_of(item.kind), count = 0, added = 0, written = 0, uncached = 0, read = 0, units = 0 }
      by[item.kind] = c
    end
    c.count = c.count + 1
    c.added = c.added + item.size
    c.written = c.written + item.written
    c.uncached = c.uncached + item.uncached
    c.read = c.read + item.read_tokens
    c.units = c.units + item.units
    c.cost = (c.cost or 0) + (usd(item.units, item.model) or 0)
    total_units = total_units + item.units
  end
  local categories = vim.tbl_values(by)
  table.sort(categories, function(a, b) return a.units > b.units end)
  for _, c in ipairs(categories) do
    c.share = total_units > 0 and c.units / total_units or 0
    for _, k in ipairs({ "added", "written", "uncached", "read" }) do c[k] = math.floor(c[k]) end
    c.output = is_output(c.kind)
    if not price then c.cost = nil end
  end

  -- The heaviest single items: what to keep out of the context next time.
  local items = vim.list_extend({}, all)
  table.sort(items, function(a, b) return a.units > b.units end)
  local top = {}
  for i = 1, math.min(#items, 12) do
    local it = items[i]
    table.insert(top, {
      label = it.label,
      kind = label_of(it.kind),
      size = math.floor(it.size),
      reads = it.reads,
      share = total_units > 0 and it.units / total_units or 0,
      cost = price and usd(it.units, it.model) or nil,
    })
  end

  -- At most 120 points for the context chart; a point that covers a miss
  -- is marked.
  local series, step = {}, math.max(1, math.ceil(#log.series / 120))
  for i = 1, #log.series, step do
    local m = 0
    for j = i, math.min(i + step - 1, #log.series) do m = math.max(m, log.series[j]) end
    table.insert(series, m)
  end
  local miss_points = {}
  for _, miss in ipairs(log.misses) do
    miss_points[#miss_points + 1] = math.floor((miss.from - 1) / step)
  end

  -- How the input arrived: the hit rate is the share of it read from the
  -- cache. Misses are the requests that sent an already-sent context again.
  local t = log.tokens
  local sent = t.read + t.write + t.input
  local misses, miss_tokens = {}, 0
  for _, miss in ipairs(log.misses) do
    miss_tokens = miss_tokens + miss.size
    table.insert(misses, {
      request = miss.from,
      tokens = math.floor(miss.size),
      written = math.floor(miss.written),
      uncached = math.floor(miss.uncached),
      idle = miss.idle,
      idle_text = miss.idle and duration(miss.idle) or nil,
      ttl = miss.ttl,
      label = miss.label,
      cost = price and usd(miss.units, miss.model) or nil,
    })
  end
  local cache = {
    hit = sent > 0 and t.read / sent or 0,
    read = t.read,
    write = t.write,
    write_1h = t.write_1h,
    uncached = t.input,
    misses = misses,
    miss_tokens = math.floor(miss_tokens),
  }

  local cost
  if price then
    cost = 0
    for model, units in pairs(log.units) do cost = cost + units * (price[model] or 0) end
  end

  return {
    requests = log.n,
    model = log.model,
    tokens = log.tokens,
    context = log.series[#log.series] or 0,
    series = series,
    miss_points = miss_points,
    cache = cache,
    categories = categories,
    top = top,
    cost = cost,
  }
end

-- The agent://usage buffer ----------------------------------------------------

local buf
local sessions = {}
local summaries = {} -- session id -> summary, rebuilt when its logs change
local line_session = {} -- line number -> session id
local selected
local period = "week"
local sort = "recent"

local function period_of(key)
  for i, p in ipairs(PERIODS) do
    if p.key == key then return p, i end
  end
end

local function usage_wins()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return {} end
  return vim.fn.win_findbuf(buf)
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
  local price = prices(session)
  s = summarize(session.log, price)
  s.id = session.id
  s.title = session.log.title or session.id:sub(1, 8)
  s.updated = session.log.updated
  s.ago = ago(session.log.updated)
  s.session_cost = session.log.cost and session.log.cost.totalCostUSD
  s.agents = {}
  for _, a in ipairs(session.agents) do
    local as = summarize(a, price)
    as.type = a.meta.agentType or "agent"
    as.description = a.meta.description or ""
    as.categories, as.series = nil, nil
    table.insert(s.agents, as)
  end
  table.sort(s.agents, function(a, b) return total(a.tokens) > total(b.tokens) end)
  summaries[session.id] = s
  return s
end

-- A session's cost for sorting and totals: its own record, else the
-- estimate from its tokens.
local function cost_of(s)
  return s.session_cost or s.cost
end

local function sort_sessions()
  if sort ~= "cost" then return end -- scan already lists them newest first
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
        cache = { hit = s.cache.hit, misses = { n = #s.cache.misses } },
        agents = { n = #s.agents },
      })
    end
  end
  local periods = {}
  for _, p in ipairs(PERIODS) do table.insert(periods, { key = p.key, label = p.label }) end
  local cards, labels = by_card()
  return {
    root = vim.fn.getcwd(), selected = selected, sessions = list,
    period = period, periods = periods, sort = sort, total = period_total(),
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
    table.insert(lines, "  — no Claude Code sessions in " .. project_dir(vim.fn.getcwd())
      .. (period ~= "all" and (" in the last " .. period_of(period).label) or ""))
  end
  local cards, labels = by_card()
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

  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  line_session = map

  -- Keep the cursor on the selected session as the list reorders.
  local here
  for lnum, id in pairs(map) do
    if id == selected then here = lnum end
  end
  for _, win in ipairs(here and usage_wins() or {}) do
    if vim.api.nvim_win_get_cursor(win)[1] ~= here then vim.api.nvim_win_set_cursor(win, { here, 2 }) end
  end
end

-- Re-read the logs; redraw and push when anything changed (or force).
function M.push(force)
  local cwd = vim.fn.getcwd()
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
  local card_costs = vim.json.encode(M.card_costs())
  changed = changed or card_costs ~= M.card_costs_seen
  M.card_costs_seen = card_costs
  sort_sessions()
  if changed or force then
    render_text()
    push_state()
  end
end

local function cursor_session()
  return line_session[vim.api.nvim_win_get_cursor(0)[1]]
end

function M.step(dir)
  local here = vim.api.nvim_win_get_cursor(0)[1]
  local lnums = vim.tbl_keys(line_session)
  table.sort(lnums)
  for i = dir > 0 and 1 or #lnums, dir > 0 and #lnums or 1, dir do
    if (dir > 0 and lnums[i] > here) or (dir < 0 and lnums[i] < here) then
      return vim.api.nvim_win_set_cursor(0, { lnums[i], 2 })
    end
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
  for lnum, sid in pairs(line_session) do
    if sid == id then return vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
  end
end

-- While a window shows the view, look for new log lines every two seconds.
-- A poll rather than a watcher: subagents write a directory further down,
-- and a read that finds nothing new is one stat per log.
local timer

local function tick()
  if #usage_wins() == 0 then
    timer:stop()
    return
  end
  -- The usage tab is always open; only read while it is in sight.
  local tab = vim.api.nvim_get_current_tabpage()
  for _, win in ipairs(usage_wins()) do
    if vim.api.nvim_win_get_tabpage(win) == tab then return M.push() end
  end
end

local function setup_buffer(b)
  vim.api.nvim_buf_set_name(b, "agent://usage")
  vim.bo[b].filetype = "corkboard"
  vim.bo[b].modifiable = false
  vim.b[b].corkboard_view = "usage"

  local function map(lhs, fn, desc)
    vim.keymap.set("n", lhs, fn, { buffer = b, nowait = true, desc = "usage: " .. desc })
  end
  map("j", function() M.step(1) end, "next session")
  map("k", function() M.step(-1) end, "previous session")
  map("<Down>", function() M.step(1) end, "next session")
  map("<Up>", function() M.step(-1) end, "previous session")
  map("R", function() M.push(true) end, "refresh")
  map("p", function() M.set_period() end, "next period")
  map("s", function() M.set_sort() end, "sort by recent/cost")

  vim.api.nvim_create_autocmd("CursorMoved", {
    buffer = b,
    callback = function()
      local id = cursor_session()
      if id and id ~= selected then
        selected = id
        render_text()
        push_state()
      end
    end,
  })
  vim.api.nvim_create_autocmd("BufWinEnter", {
    buffer = b,
    callback = function()
      if not timer:is_active() then timer:start(2000, 2000, vim.schedule_wrap(tick)) end
    end,
  })
  -- Back on the tab: what changed while it was out of sight.
  vim.api.nvim_create_autocmd("BufEnter", { buffer = b, callback = function() M.push() end })
end

-- The usage tab ---------------------------------------------------------------
--
-- Like the board's: tab 2, put back after anything closes or moves it.

local function usage_tab()
  for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
    if vim.t[tab].corkboard_usage then return tab end
  end
end

local function tab_win(tab)
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    if vim.api.nvim_win_get_buf(win) == buf then return win end
  end
end

local ensuring = false

-- Keep the usage tab second, with the view in it. Leaves focus where it was.
-- Runs after board.ensure, so tab 1 is already the board.
function M.ensure()
  if ensuring or vim.v.exiting ~= vim.NIL then return end
  ensuring = true
  local ok, err = pcall(function()
    timer = timer or assert(vim.uv.new_timer())
    if not (buf and vim.api.nvim_buf_is_valid(buf)) then
      buf = vim.api.nvim_create_buf(true, true)
      setup_buffer(buf)
    end
    local from = vim.api.nvim_get_current_win()
    local created = false

    local tab = usage_tab()
    if not tab then
      vim.cmd("1tabnew")
      tab = vim.api.nvim_get_current_tabpage()
      vim.t[tab].corkboard_usage = true
      local empty = vim.api.nvim_get_current_buf()
      vim.api.nvim_win_set_buf(0, buf)
      pcall(vim.api.nvim_buf_delete, empty, {})
      created = true
    end

    if vim.api.nvim_tabpage_get_number(tab) ~= 2 then
      vim.api.nvim_set_current_tabpage(tab)
      vim.cmd("tabmove 1")
    end

    if not tab_win(tab) then
      vim.api.nvim_set_current_tabpage(tab)
      vim.cmd("topleft vsplit")
      vim.api.nvim_win_set_buf(0, buf)
      created = true
    end

    if vim.api.nvim_win_is_valid(from) then vim.api.nvim_set_current_win(from) end
    if created then M.push(true) end
  end)
  ensuring = false
  if not ok then vim.notify("corkboard: " .. tostring(err), vim.log.levels.ERROR) end
end

-- Go to the usage tab.
function M.show()
  M.ensure()
  local tab = usage_tab()
  vim.api.nvim_set_current_tabpage(tab)
  vim.api.nvim_set_current_win(tab_win(tab))
  M.push(true)
end

-- For a new browser channel: the last state again, if the view exists.
function M.push_all()
  if buf and vim.api.nvim_buf_is_valid(buf) then push_state() end
end

return M
