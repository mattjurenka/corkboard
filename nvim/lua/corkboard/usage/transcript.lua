-- Reading Claude Code's session logs: what each request cost and what it
-- went on.
--
-- An assistant record carries the API usage of the request that produced it;
-- one response is split over several records that repeat the same usage, so
-- requests are counted once per message id.
--
-- Attribution: a request's new tokens (input + cache writes) are whatever
-- joined the context since the request before it: tool results, prompts,
-- reminders, the previous reply. The real count is split between those items
-- by their estimated sizes (bytes / 4), so estimates decide shares, never
-- totals. Each item is then read back from the cache by every later request
-- until a compaction drops it, which is where most tokens go: a 10k-token
-- file read early in a 200-request session costs about 2M cache reads.
--
-- Cost: requests are weighed in input-token units (cache read 0.1, input 1,
-- 5-minute cache write 1.25, 1-hour write 2, output 5, the same ratios on
-- every Claude model), and the session's own costUSD per model (its
-- cost-state record, subagents included) prices a unit. Sessions without one
-- show tokens only.

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
    times = {}, -- and when it was sent, in seconds
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
  table.insert(log.times, log.prev_time or 0)
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

-- Logs are kept across reads, so each read only parses what was appended.
local logs = {} -- path -> log

-- The log at path, brought up to date; and whether it grew.
function M.read(path, cwd)
  logs[path] = logs[path] or new_log(path)
  local log = logs[path]
  return log, update(log, cwd)
end

-- Summaries -------------------------------------------------------------------

-- Dollars per input-token unit for each model, from the session's
-- cost-state over the units seen in it and its subagents.
function M.prices(session)
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

function M.summarize(log, price)
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

  -- At most 120 points for the context chart, each at the seconds from the
  -- first request to the first it covers; a point that covers a miss is
  -- marked.
  local series, times, step = {}, {}, math.max(1, math.ceil(#log.series / 120))
  local start = log.times[1] or 0
  for i = 1, #log.series, step do
    local m = 0
    for j = i, math.min(i + step - 1, #log.series) do m = math.max(m, log.series[j]) end
    table.insert(series, m)
    table.insert(times, math.max(0, (log.times[i] or start) - start))
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
    times = times,
    miss_points = miss_points,
    cache = cache,
    categories = categories,
    top = top,
    cost = cost,
  }
end

M.short = short
M.duration = duration

return M
