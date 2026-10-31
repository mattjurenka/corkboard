-- The brains (.agent/plans/brains.md, cloud/src/brains.ts): who agents work
-- for, each with its memory's counts, its account, what it holds and its
-- abilities. The default one is what your own sessions remember in.
--
-- The view is the agent://brains buffer, fourth among the tabs after the
-- fleet: a plain listing with the browser's HTML drawn over it. The cursor's
-- line selects a brain. a makes one and e edits it, in a buffer of its
-- fields written with :w; d archives it (asked first), u restores it, and P
-- purges an archived one, its name typed again. It follows the user's
-- socket, which says when a brain changes.

local pinned = require("corkboard.pinned")

local M = {}

local buf
local line_item = {} -- line number -> brain name
local selected
local brains -- as the Worker answers, archived ones too
local problem
local asking -- { name, what = "archive" }: d's question, until it's answered

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
      credentials = list(b.credentials), abilities = list(b.abilities), egress = list(b.egress),
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
  local lines, map = { "Brains     j/k · a new · e edit · d archive · u restore · P purge · R refresh", "" }, {}
  if s.problem then table.insert(lines, "  " .. s.problem) end
  if s.loading then table.insert(lines, "  asking the Worker…") end
  if s.asking then table.insert(lines, "  archive " .. s.asking.name .. "?  y yes · n no") end
  for _, c in ipairs(s.cards) do
    local head = { c.name, c.title }
    if c.default then table.insert(head, "default") end
    if c.account then table.insert(head, c.account) end
    if c.archived then table.insert(head, "archived " .. c.archived) end
    table.insert(lines, "  " .. table.concat(head, "  · "))
    map[#lines] = c.name
    if c.description and c.description ~= "" then table.insert(lines, "    " .. (c.description:match("^[^\n]*") or "")) end
    local m = c.memory
    table.insert(lines, string.format("    %s notes · %s entries · %s episodes%s", count(m.notes), count(m.entries), count(m.episodes), m.last and (" · " .. m.last) or ""))
    local holds = vim.list_extend(vim.list_slice(c.credentials), c.abilities)
    if #holds > 0 then table.insert(lines, "    " .. table.concat(holds, " ")) end
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

function M.load()
  if not cloud().enabled() then
    problem = "brains need corkboard's bridge and the cloud"
    return redraw()
  end
  local ok, res = pcall(cloud().call, "brains_get")
  if ok then
    brains, problem = res, nil
  else
    problem = tostring(res)
  end
  if not selected and brains and brains[1] then selected = brains[1].name end
  redraw()
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

-- From the bridge: the user's socket (fleet.lua passes brains' on).
function M.cloud_event(event)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
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

local FIELDS = { "name", "title", "account", "default", "credentials", "abilities", "egress" }

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
  out.default = b.default == "true"
  for _, k in ipairs({ "credentials", "abilities", "egress" }) do
    out[k] = vim.iter(vim.split(b[k] or "", ",")):map(vim.trim):filter(function(x) return x ~= "" end):totable()
  end
  return out
end

local function edit(b)
  local new = b == nil
  b = b or { name = "", title = "", default = false, credentials = {}, abilities = {}, egress = {} }
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

function M.new() edit(nil) end

function M.edit()
  local b = selected and find(selected)
  if b then edit(b) end
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

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  buf = pinned.listing("agent://brains", "brains", {
    j = { function() pinned.step(line_item, 1) end, "next" },
    k = { function() pinned.step(line_item, -1) end, "previous" },
    ["<CR>"] = { or_answer(true, M.edit), "edit it" },
    a = { M.new, "a new brain" },
    e = { M.edit, "edit it" },
    d = { M.archive, "archive it" },
    u = { M.restore, "restore it" },
    P = { M.purge, "purge it" },
    y = { or_answer(true), "yes, archive it" },
    n = { or_answer(false), "no, leave it" },
    ["<Esc>"] = { or_answer(false), "no, leave it" },
    R = { M.load, "refresh" },
  }, function() return line_item end, function(name)
    if name == selected then return end
    selected = name
    if asking and asking.name ~= name then asking = nil end
    redraw()
  end)
  vim.api.nvim_create_autocmd("BufEnter", { buffer = buf, callback = function() vim.schedule(M.load) end })
  return buf
end

-- Keep the brains fourth among the tabs, after the fleet.
function M.ensure()
  if pinned.ensure("corkboard_brains", 4, buffer()) then vim.schedule(M.load) end
end

function M.show()
  M.ensure()
  pinned.show("corkboard_brains", 4, buffer())
end

function M.push_all()
  if buf and vim.api.nvim_buf_is_valid(buf) then push_state() end
end

M.state = state
M.from_lines = from_lines
M.to_lines = to_lines

return M
