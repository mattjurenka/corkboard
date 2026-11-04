-- The brains (.agent/plans/brains.md, the hosted Worker's brains.ts): who agents work
-- for, each with its memory's counts, its account, what it holds, its
-- abilities and its avatar's persona (corkboard.personas) and skin. The default
-- one is what your own sessions remember in.
--
-- The view is the agent://brains buffer, fourth among the tabs after the
-- fleet: a plain listing with the browser's HTML drawn over it. The cursor's
-- line selects a brain. <CR> opens its memory beside the listing; a makes
-- one and e edits it, in the page's form (in a bare Neovim, a buffer of its
-- fields written with :w); d archives it (asked first), u restores it, and P purges an archived one, its name
-- typed again. H opens what they hold (corkboard.holds) beside it. It
-- follows the user's socket, which says when a brain changes.
--
-- A brain's memory is agent://brains/<name>, drawn over by the browser too:
-- its notes by kind, the days of its log and its episodes, and / recalls
-- over them. <CR> opens the line's note, day or transcript below it.

local pinned = require("corkboard.pinned")

local M = {}

local buf
local line_item = {} -- line number -> brain name
local selected
local brains -- as the Worker answers, archived ones too
local problem
local asking -- { name, what = "archive" }: d's question, until it's answered

local push_memory -- below, with the memory buffers

local function cloud() return require("corkboard.cards.cloud") end

local function nil_if_null(v)
  if v == vim.NIL then return nil end
  return v
end

local function age(iso)
  if type(iso) ~= "string" then return nil end
  local y, mo, d, h, mi, s = iso:match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
  if not y then return nil end
  local t = os.time({ year = y, month = mo, day = d, hour = h, min = mi, sec = s, isdst = false })
  local now = os.time()
  return now - t - os.difftime(now, os.time(os.date("!*t", now)))
end

local function ago(iso)
  local secs = age(iso)
  if not secs then return nil end
  if secs < 60 then return "now" end
  if secs < 3600 then return math.floor(secs / 60) .. "m ago" end
  if secs < 86400 then return math.floor(secs / 3600) .. "h ago" end
  return math.floor(secs / 86400) .. "d ago"
end

local function count(n)
  n = tonumber(n) or 0
  if n >= 1000 then return string.format("%.1fk", n / 1000) end
  return tostring(n)
end

local function plural(n, one, many) return count(n) .. " " .. (n == 1 and one or many) end

local function list(v) return type(v) == "table" and v or {} end

local function find(name)
  return vim.iter(brains or {}):find(function(b) return b.name == name end)
end

-- What the page is sent: a card per brain, live ones first.
local function state()
  local cards = {}
  for _, b in ipairs(brains or {}) do
    local m = nil_if_null(b.memory) or {}
    table.insert(cards, {
      name = b.name, title = b.title, description = nil_if_null(b.description), account = nil_if_null(b.account),
      default = b.default or nil, archived = nil_if_null(b.archived) and ago(b.archived) or nil,
      credentials = list(b.credentials), abilities = list(b.abilities), persona = nil_if_null(b.persona), skin = nil_if_null(b.skin),
      memory = { notes = m.notes or 0, entries = m.entries or 0, episodes = m.episodes or 0, last = ago(nil_if_null(m.lastEpisode)) },
    })
  end
  table.sort(cards, function(a, b)
    if (a.archived ~= nil) ~= (b.archived ~= nil) then return a.archived == nil end
    if (a.default or false) ~= (b.default or false) then return a.default == true end
    return a.name < b.name
  end)
  return { cards = cards, selected = selected, asking = asking, problem = problem, loading = (not brains and not problem) or nil }
end

local function push_state()
  require("corkboard").notify("corkboard.brains", state())
end

local function render_text()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local s = state()
  local lines, map = { "Brains" .. string.rep(" ", 40) .. "a new brain · H holds", "" }, {}
  if s.problem then table.insert(lines, "  " .. s.problem) end
  if s.loading then table.insert(lines, "  asking the Worker…") end
  if s.asking then table.insert(lines, "  archive " .. s.asking.name .. "?  y yes · n no") end
  if not s.loading and not s.problem and not vim.iter(s.cards):any(function(c) return not c.archived end) then
    table.insert(lines, "  No brains.")
  end
  local function field(label, value) table.insert(lines, string.format("    %-8s %s", label, value)) end
  local archived = false
  for _, c in ipairs(s.cards) do
    if c.archived and not archived then
      archived = true
      table.insert(lines, "Archived")
    end
    local head = { c.title }
    if c.name ~= c.title:lower() then table.insert(head, c.name) end
    if c.default then table.insert(head, "● default") end
    if c.archived then table.insert(head, "archived " .. c.archived) end
    table.insert(lines, "  " .. table.concat(head, "  "))
    map[#lines] = c.name
    if c.description and c.description ~= "" then table.insert(lines, "    " .. (c.description:match("^[^\n]*") or "")) end
    local m = c.memory
    if m.notes + m.entries + m.episodes == 0 then
      field("memory", "empty")
    else
      field("memory", string.format("%s · %s · %s", plural(m.notes, "note", "notes"), plural(m.entries, "log entry", "log entries"),
        plural(m.episodes, "session", "sessions")))
    end
    if m.last then field("active", m.last) end
    field("runs as", c.account or "the machine's default account")
    if #c.credentials > 0 then field("holds", table.concat(c.credentials, " ") .. "  agents need your OK to spawn it") end
    if #c.abilities > 0 then field("can", table.concat(c.abilities, " ")) end
    if c.persona then field("persona", c.persona) end
    if c.skin then field("skin", c.skin) end
    table.insert(lines, c.archived and "    u restore · P purge" or "    <CR> open memory · e edit · d archive")
    table.insert(lines, "")
  end
  pinned.set_lines(buf, lines)
  line_item = map
  pinned.follow(buf, line_item, selected)
end

local function redraw()
  render_text()
  push_state()
end

local loads = 0
function M.load()
  if not cloud().enabled() then
    problem = "brains need corkboard's bridge and the cloud"
    return redraw()
  end
  -- Not waited for, as the fleet's (fleet.lua): only the latest is kept.
  loads = loads + 1
  local n = loads
  cloud().call_async("brains_get", function(err, res)
    if n ~= loads then return end
    if err then
      problem = tostring(err)
    else
      brains, problem = res, nil
    end
    if not selected and brains and brains[1] then selected = brains[1].name end
    redraw()
    require("corkboard.avatar").personas_changed()
  end)
end

-- A brain's persona and skin, or the default brain's for nil
-- (corkboard.avatar); nil for either it hasn't. The brains are asked for
-- once if they haven't been.
local asked = false
function M.persona_of(name)
  if not brains and not asked then
    asked = true
    M.load()
  end
  local b = vim.iter(brains or {}):find(function(x)
    if name then return x.name == name end
    return x.default == true and not nil_if_null(x.archived)
  end)
  if not b then return nil end
  return nil_if_null(b.persona), nil_if_null(b.skin)
end

local pending = false
local function reload()
  if pending then return end
  pending = true
  vim.defer_fn(function()
    pending = false
    M.load()
  end, 300)
end

-- From the bridge: the user's socket (fleet.lua passes brains' on). Kept
-- up while the view is there, or they've been read for a persona.
function M.cloud_event(event)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) and not brains then return end
  if event.type == "brain" or event.type == "reconnected" then reload() end
end

-- A call, with a toast about name while the Worker answers; the answer, or nil.
local function act(op, verb, name, ...)
  local ui = require("corkboard")
  local id = "brain-" .. op .. "-" .. name
  ui.toast(id, "pending", verb .. " " .. name)
  local ok, res = pcall(cloud().call, op, ...)
  if ok then
    ui.toast(id, "done", verb .. " " .. name .. ": done")
  else
    ui.toast(id, "error", "couldn't " .. verb .. " " .. name .. ": " .. tostring(res))
  end
  reload()
  return ok and res or nil
end

-- Editing ----------------------------------------------------------------------
--
-- A brain as lines, `key: value`, lists comma-separated, the description
-- last and as long as it likes. :w makes it (a new one) or changes it.

local FIELDS = { "name", "title", "account", "persona", "skin", "default", "credentials", "abilities" }

local function to_lines(b)
  local out = {}
  for _, k in ipairs(FIELDS) do
    local v = nil_if_null(b[k])
    if type(v) == "table" then v = table.concat(v, ", ") end
    if type(v) == "boolean" then v = tostring(v) end
    table.insert(out, k .. ": " .. (v or ""))
  end
  table.insert(out, "description:")
  for _, l in ipairs(vim.split(nil_if_null(b.description) or "", "\n")) do table.insert(out, l) end
  return out
end

local function from_lines(lines)
  local b, desc, at = {}, {}, nil
  for i, l in ipairs(lines) do
    if at then
      table.insert(desc, l)
    elseif l:match("^description:") then
      at = i
      local rest = vim.trim(l:sub(#"description:" + 1))
      if rest ~= "" then table.insert(desc, rest) end
    else
      local k, v = l:match("^(%w+):%s*(.-)%s*$")
      if k then b[k] = v end
    end
  end
  local out = { name = b.name, title = b.title, description = vim.trim(table.concat(desc, "\n")) }
  out.account = (b.account and b.account ~= "") and b.account or vim.NIL
  out.persona = (b.persona and b.persona ~= "") and b.persona or vim.NIL
  out.skin = (b.skin and b.skin ~= "") and b.skin or vim.NIL
  out.default = b.default == "true"
  for _, k in ipairs({ "credentials", "abilities" }) do
    out[k] = vim.iter(vim.split(b[k] or "", ",")):map(vim.trim):filter(function(x) return x ~= "" end):totable()
  end
  return out
end

local function edit(b)
  local new = b == nil
  b = b or { name = "", title = "", default = false, credentials = {}, abilities = {} }
  local e = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(e, "agent://brain/" .. (new and "new" or b.name))
  vim.bo[e].buftype = "acwrite"
  vim.bo[e].bufhidden = "wipe"
  vim.api.nvim_buf_set_lines(e, 0, -1, false, to_lines(b))
  vim.bo[e].modified = false
  local updated = nil_if_null(b.updated)
  vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = e,
    callback = function()
      local f = from_lines(vim.api.nvim_buf_get_lines(e, 0, -1, false))
      local res
      if new then
        res = act("brains_create", "making", f.name ~= "" and f.name or "a brain", f)
      else
        if f.name ~= b.name then return vim.notify("corkboard: a brain's name never changes; its title does", vim.log.levels.WARN) end
        f.name = nil
        f.updated = updated
        res = act("brains_update", "saving", b.name, b.name, f)
      end
      if not res then return end
      if res.stale then
        vim.notify("corkboard: " .. b.name .. " changed since; here it is now, with your edit lost", vim.log.levels.WARN)
        updated = res.stale.updated
        vim.api.nvim_buf_set_lines(e, 0, -1, false, to_lines(res.stale))
        vim.bo[e].modified = false
        return
      end
      vim.bo[e].modified = false
      selected = res.name or selected
      vim.api.nvim_buf_delete(e, { force = true })
    end,
  })
  vim.cmd("botright split")
  vim.api.nvim_win_set_buf(0, e)
end

-- On the page, a form of its own (web/src/components/BrainForm.tsx) over
-- the view: accounts and labels are picked from the live brains', and a new
-- brain may start from one of them. It saves with save().
local ABILITIES = { "chat" }

local function fields(b)
  return {
    name = b.name, title = b.title, description = nil_if_null(b.description) or "", account = nil_if_null(b.account),
    credentials = list(b.credentials), abilities = list(b.abilities), persona = nil_if_null(b.persona), skin = nil_if_null(b.skin), default = b.default == true,
    updated = nil_if_null(b.updated),
  }
end

local function form(b)
  local corkboard = require("corkboard")
  if not corkboard.attached() then return edit(b) end
  local live = vim.iter(brains or {}):filter(function(x) return not nil_if_null(x.archived) end):map(fields):totable()
  corkboard.notify("corkboard.brain_form", { brain = b and fields(b) or nil, brains = live, abilities = ABILITIES, personas = require("corkboard.personas").IDS })
end

-- The form's save: name, and the updated it was read with, for a change;
-- neither for a new one. What came of it: { name }, { stale, problem } with
-- the brain as it is now, or { problem }.
function M.save(name, updated, f)
  name = nil_if_null(name)
  local ok, res
  if name then
    ok, res = pcall(cloud().call, "brains_update", name, vim.tbl_extend("force", f, { updated = updated }))
  else
    ok, res = pcall(cloud().call, "brains_create", f)
  end
  if not ok then return { problem = tostring(res) } end
  if res.stale then return { stale = fields(res.stale), problem = (nil_if_null(res.error) or "it changed since") .. "; this is it now" } end
  selected = res.name or name
  reload()
  return { name = selected }
end

function M.new() form(nil) end

function M.edit()
  local b = selected and find(selected)
  if b then form(b) end
end

function M.archive()
  local b = selected and find(selected)
  if not b or nil_if_null(b.archived) then return end
  asking = { name = b.name }
  redraw()
end

function M.answer(yes)
  local a = asking
  asking = nil
  redraw()
  if a and yes then act("brains_archive", "archiving", a.name, a.name) end
end

function M.restore()
  local b = selected and find(selected)
  if b and nil_if_null(b.archived) then act("brains_restore", "restoring", b.name, b.name) end
end

-- An archived brain's memory, for good: its name, typed again, says so.
function M.purge()
  local b = selected and find(selected)
  if not b then return end
  if not nil_if_null(b.archived) then return vim.notify("corkboard: archive " .. b.name .. " first") end
  vim.ui.input({ prompt = "Type " .. b.name .. " to empty its memory for good: " }, function(typed)
    if typed == b.name then
      selected = nil
      act("brains_purge", "purging", b.name, b.name)
    end
  end)
end

local function or_answer(yes, otherwise)
  return function()
    if asking then return M.answer(yes) end
    if otherwise then otherwise() end
  end
end

-- A click on a brain in the browser.
function M.select(name, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(line_item, name)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
end

-- A button on a brain in the browser: select it, then do what.
function M.act(name, what, win)
  M.select(name, win)
  if selected ~= name then
    selected = name
    redraw()
  end
  local f = ({ memory = M.memory, edit = M.edit, archive = M.archive, restore = M.restore, purge = M.purge })[what]
  if f then f() end
end

-- Memory -----------------------------------------------------------------------
--
-- One buffer per brain, its state in mem[buf]: what the Worker gave, which
-- line is which item, the selected one, and the last recall.

local mem = {} -- buf -> { name, title, notes, days, episodes, recall, lines, selected, problem }

local function size(bytes)
  bytes = tonumber(bytes) or 0
  if bytes >= 1048576 then return string.format("%.1f MB", bytes / 1048576) end
  if bytes >= 1024 then return math.floor(bytes / 1024) .. " KB" end
  return bytes .. " B"
end

local function entries(n) return n .. (n == 1 and " entry" or " entries") end

-- What the page is sent: the sections, each a list of items with keys.
local function memory_state(b)
  local m = mem[b]
  local kinds, by = {}, {}
  for _, n in ipairs(m.notes or {}) do
    if not by[n.kind] then
      by[n.kind] = {}
      table.insert(kinds, n.kind)
    end
    table.insert(by[n.kind], { key = "note:" .. n.id, id = n.id, title = n.title, ago = ago(n.updated) })
  end
  table.sort(kinds)
  return {
    buf = b,
    name = m.name,
    title = m.title,
    notes = vim.tbl_map(function(k) return { kind = k, notes = by[k] } end, kinds),
    days = vim.tbl_map(function(d) return { key = "day:" .. d.day, day = d.day, entries = d.entries } end, m.days or {}),
    episodes = vim.tbl_map(function(e)
      return { key = "episode:" .. e.id, ago = ago(e.at), agent = e.agent, trigger = e.trigger, size = size(e.bytes), pending = e.consolidated == 0 or nil }
    end, m.episodes or {}),
    recall = m.recall and {
      query = m.recall.query,
      hits = vim.iter(ipairs(m.recall.hits)):map(function(i, h)
        return { key = "hit:" .. i, title = h.title, kind = nil_if_null(h.kind), snippet = h.snippet, ago = ago(h.at) }
      end):totable(),
    },
    selected = m.selected,
    problem = m.problem,
    loading = (not m.notes and not m.problem) or nil,
  }
end

push_memory = function(b)
  if mem[b] then require("corkboard").notify("corkboard.view", b, memory_state(b)) end
end

local function render_memory(b)
  local m = mem[b]
  if not (m and vim.api.nvim_buf_is_valid(b)) then return end
  local s = memory_state(b)
  local lines, map = { s.name .. " · " .. s.title .. "     j/k · <CR> open · / recall · <Esc> clear · R refresh · q close", "" }, {}
  local function item(key, text)
    table.insert(lines, text)
    map[#lines] = key
  end
  if s.problem then table.insert(lines, "  " .. s.problem) end
  if s.loading then table.insert(lines, "  asking the Worker…") end
  if s.recall then
    table.insert(lines, "Recall: " .. s.recall.query)
    if #s.recall.hits == 0 then table.insert(lines, "  nothing") end
    for _, h in ipairs(s.recall.hits) do
      item(h.key, string.format("  %-40s %s", h.title, h.ago or ""))
      table.insert(lines, "    " .. (h.snippet or ""):gsub("\n", " "))
    end
    table.insert(lines, "")
  end
  if not s.loading then
    table.insert(lines, "Notes")
    if #s.notes == 0 then table.insert(lines, "  none") end
    for _, k in ipairs(s.notes) do
      table.insert(lines, "  " .. k.kind)
      for _, n in ipairs(k.notes) do item(n.key, string.format("    %-28s %-40s %s", n.id, n.title, n.ago or "")) end
    end
    table.insert(lines, "")
    table.insert(lines, "Log")
    if #s.days == 0 then table.insert(lines, "  none") end
    for _, d in ipairs(s.days) do item(d.key, "  " .. d.day .. "  " .. entries(d.entries)) end
    table.insert(lines, "")
    table.insert(lines, "Sessions")
    if #s.episodes == 0 then table.insert(lines, "  none") end
    for _, e in ipairs(s.episodes) do
      item(e.key, string.format("  %-8s %-16s %-8s %-8s%s", e.ago or "", e.agent, e.trigger, e.size, e.pending and "  pending" or ""))
    end
  end
  pinned.set_lines(b, lines)
  m.lines = map
  -- The first item, until one is picked.
  if not m.selected or not pinned.line_of(map, m.selected) then
    local first = vim.iter(vim.tbl_keys(map)):fold(math.huge, math.min)
    m.selected = map[first]
  end
  pinned.follow(b, map, m.selected)
end

local function redraw_memory(b)
  render_memory(b)
  push_memory(b)
end

local function call(op, ...)
  local ok, res = pcall(cloud().call, op, ...)
  if ok then return res end
  vim.notify("corkboard: " .. tostring(res), vim.log.levels.WARN)
end

-- All three at once, not waited for; drawn when the last answers, unless a
-- later load or the buffer's wipeout came first.
local function load_memory(b)
  local m = mem[b]
  if not m then return end
  m.loads = (m.loads or 0) + 1
  local n, got, left, problem = m.loads, {}, 3, nil
  for _, what in ipairs({ "notes", "days", "episodes" }) do
    cloud().call_async("brains_" .. what, function(err, res)
      if mem[b] ~= m or m.loads ~= n then return end
      if err then problem = problem or tostring(err) end
      got[what] = res
      left = left - 1
      if left > 0 then return end
      if problem then
        m.problem = problem
      else
        m.notes, m.days, m.episodes, m.problem = got.notes, got.days, got.episodes, nil
      end
      redraw_memory(b)
    end, m.name)
  end
end

-- A read-only scratch buffer below, q to close it.
local function scratch(name, lines)
  local old = vim.fn.bufnr(name)
  if old ~= -1 then pcall(vim.api.nvim_buf_delete, old, { force = true }) end
  local s = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(s, name)
  vim.bo[s].bufhidden = "wipe"
  vim.bo[s].filetype = "markdown"
  vim.api.nvim_buf_set_lines(s, 0, -1, false, lines)
  vim.bo[s].modifiable = false
  vim.keymap.set("n", "q", "<Cmd>close<CR>", { buffer = s, nowait = true, desc = "brains: close" })
  vim.cmd("botright split")
  vim.api.nvim_win_set_buf(0, s)
end

local function text_of(content)
  if type(content) == "string" then return content end
  local out = {}
  for _, c in ipairs(type(content) == "table" and content or {}) do
    if c.type == "text" then
      table.insert(out, c.text)
    elseif c.type == "tool_use" then
      table.insert(out, "→ " .. tostring(c.name) .. " " .. vim.json.encode(c.input or vim.empty_dict()):sub(1, 200))
    elseif c.type == "tool_result" then
      table.insert(out, "← " .. text_of(c.content):sub(1, 400))
    end
  end
  return table.concat(out, "\n")
end

-- A transcript, as Claude Code writes it (a JSON line per event), as who
-- said what.
local function transcript_lines(raw)
  local out = {}
  for line in raw:gmatch("[^\n]+") do
    local ok, ev = pcall(vim.json.decode, line)
    if ok and type(ev) == "table" and (ev.type == "user" or ev.type == "assistant") and type(ev.message) == "table" then
      local t = vim.trim(text_of(ev.message.content))
      if t ~= "" then
        table.insert(out, "## " .. ev.type .. (type(ev.timestamp) == "string" and ("  " .. ev.timestamp) or ""))
        vim.list_extend(out, vim.split(t, "\n", { plain = true }))
        table.insert(out, "")
      end
    elseif not ok then
      table.insert(out, line)
    end
  end
  return out
end

local function open_day(m, day)
  local list = call("brains_entries", m.name, day)
  if not list then return end
  local lines = { "# " .. m.name .. " · " .. day, "" }
  for _, e in ipairs(list) do
    local text = vim.split(e.text or "", "\n", { plain = true })
    table.insert(lines, string.format("- %s %s: %s", (e.at or ""):match("T(%d+:%d+)") or "", e.who, text[1] or ""))
    for i = 2, #text do table.insert(lines, "  " .. text[i]) end
  end
  scratch("agent://brains/" .. m.name .. "/log/" .. day, lines)
end

local function open_item(b, key)
  local m = mem[b]
  if not (m and key) then return end
  local kind, id = key:match("^(%w+):(.*)$")
  if kind == "hit" then
    local h = m.recall and m.recall.hits[tonumber(id)]
    if not h then return end
    if h.type == "entry" then return open_day(m, h.day) end
    kind, id = "note", h.id
  end
  if kind == "note" then
    local n = call("brains_note", m.name, id)
    if not n then return end
    local lines = { "# " .. n.title, "" }
    vim.list_extend(lines, vim.split(n.body or "", "\n", { plain = true }))
    scratch("agent://brains/" .. m.name .. "/note/" .. id, lines)
  elseif kind == "day" then
    open_day(m, id)
  elseif kind == "episode" then
    local e = call("brains_episode", m.name, id)
    if e then scratch("agent://brains/" .. m.name .. "/episode/" .. id, transcript_lines(e.transcript or "")) end
  end
end

local function recall(b)
  local m = mem[b]
  vim.ui.input({ prompt = "Recall: ", default = m.recall and m.recall.query or nil }, function(q)
    q = q and vim.trim(q) or ""
    if q == "" then return end
    local hits = call("brains_recall", m.name, q)
    if not hits then return end
    m.recall = { query = q, hits = hits }
    m.selected = hits[1] and "hit:1" or nil
    redraw_memory(b)
  end)
end

local function memory_buffer(name)
  for b, m in pairs(mem) do
    if m.name == name and vim.api.nvim_buf_is_valid(b) then return b end
  end
  local b
  local function items() return mem[b] and mem[b].lines or {} end
  local function step(dir) return function() pinned.step(items(), dir) end end
  b = pinned.listing("agent://brains/" .. name, "brain-memory", {
    j = { pinned.nav("down", items, step(1)), "down" },
    k = { pinned.nav("up", items, step(-1)), "up" },
    h = { pinned.nav("left", items, function() end), "left" },
    l = { pinned.nav("right", items, function() end), "right" },
    ["<CR>"] = { function() open_item(b, mem[b].selected) end, "open it" },
    ["/"] = { function() recall(b) end, "recall" },
    ["<Esc>"] = {
      function()
        if not mem[b].recall then return end
        mem[b].recall, mem[b].selected = nil, nil
        redraw_memory(b)
      end,
      "clear the recall",
    },
    R = { function() load_memory(b) end, "refresh" },
    q = { "<Cmd>close<CR>", "close" },
  }, items, function(key)
    if mem[b].selected == key then return end
    mem[b].selected = key
    push_memory(b)
  end)
  vim.bo[b].bufhidden = "wipe"
  vim.b[b].corkboard_brain_memory = name
  local f = find(name)
  mem[b] = { name = name, title = f and f.title or name }
  vim.api.nvim_create_autocmd("BufWipeout", { buffer = b, callback = function() mem[b] = nil end })
  return b
end

-- The selected brain's memory (or name's), beside the listing.
function M.memory(name)
  name = name or selected
  if not name then return end
  local b = memory_buffer(name)
  local win = vim.iter(vim.api.nvim_tabpage_list_wins(0)):find(function(w)
    return vim.b[vim.api.nvim_win_get_buf(w)].corkboard_brain_memory ~= nil
  end)
  if win then
    vim.api.nvim_set_current_win(win)
  else
    vim.cmd("botright vsplit")
  end
  vim.api.nvim_win_set_buf(0, b)
  load_memory(b)
end

-- A click on an item in the browser; with open, a double click.
function M.memory_select(b, key, win, open)
  if not mem[b] then return end
  if not (win and vim.api.nvim_win_is_valid(win)) then win = vim.fn.win_findbuf(b)[1] end
  if not win then return end
  vim.api.nvim_set_current_win(win)
  local lnum = pinned.line_of(mem[b].lines or {}, key)
  if lnum then vim.api.nvim_win_set_cursor(win, { lnum, 2 }) end
  mem[b].selected = key
  push_memory(b)
  if open then open_item(b, key) end
end

local function items() return line_item end

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  buf = pinned.listing("agent://brains", "brains", {
    j = { pinned.nav("down", items, function() pinned.step(line_item, 1) end), "down" },
    k = { pinned.nav("up", items, function() pinned.step(line_item, -1) end), "up" },
    h = { pinned.nav("left", items, function() pinned.step(line_item, -1) end), "left" },
    l = { pinned.nav("right", items, function() pinned.step(line_item, 1) end), "right" },
    ["<CR>"] = { or_answer(true, function() M.memory() end), "its memory" },
    a = { M.new, "a new brain" },
    e = { M.edit, "edit it" },
    d = { M.archive, "archive it" },
    u = { M.restore, "restore it" },
    P = { M.purge, "purge it" },
    H = { function() require("corkboard.holds").show() end, "what they hold" },
    y = { or_answer(true), "yes, archive it" },
    n = { or_answer(false), "no, leave it" },
    ["<Esc>"] = { or_answer(false), "no, leave it" },
    R = { M.load, "refresh" },
  }, items, function(name)
    if name == selected then return end
    selected = name
    if asking and asking.name ~= name then asking = nil end
    redraw()
  end)
  vim.api.nvim_create_autocmd("BufEnter", { buffer = buf, callback = function() vim.schedule(M.load) end })
  return buf
end

-- Keep the brains after the fleet among the tabs, or after usage without it.
local function index() return require("corkboard.features").on("fleet") and 4 or 3 end

function M.ensure()
  if pinned.ensure("corkboard_brains", index(), buffer()) then vim.schedule(M.load) end
end

function M.show()
  M.ensure()
  pinned.show("corkboard_brains", index(), buffer())
end

function M.push_all()
  if buf and vim.api.nvim_buf_is_valid(buf) then push_state() end
  require("corkboard.holds").push_all()
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.b[b].corkboard_brain_memory then push_memory(b) end
  end
end

M.state = state
M.from_lines = from_lines
M.to_lines = to_lines

return M
