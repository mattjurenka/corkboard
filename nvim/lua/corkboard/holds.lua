-- What brains hold (the hosted Worker's holds.ts): each hold, what it's for, whether
-- its secret is kept here (and handed to a spawn holding it) or where it is
-- kept, and the brains and templates holding it; above them, the spawns an
-- agent asked for that wait on you because of one.
--
-- The view is agent://holds, H from the brains view, beside it: a plain
-- listing with the browser's HTML drawn over it. The cursor's line selects.
-- On a waiting spawn, A approves it, x denies it and <CR> opens its task; on
-- a hold, a makes one and e (or <CR>) edits it, in the page's form (in a bare
-- Neovim, a buffer of its fields written with :w, s setting its secret and
-- S forgetting it); d deletes it, asked first.

local pinned = require("corkboard.pinned")

local M = {}

local buf
local line_item = {} -- line number -> "hold:<name>" or "wait:<id>"
local selected
local holds -- as the Worker answers
local waiting -- the spawns pending your approval
local problem
local asking -- { name, what = "delete" | "forget" }: the question, until it's answered

local function cloud() return require("corkboard.cards.cloud") end

local function nil_if_null(v)
  if v == vim.NIL then return nil end
  return v
end

local function list(v) return type(v) == "table" and v or {} end

local function ago(iso)
  if type(iso) ~= "string" then return nil end
  local y, mo, d, h, mi, s = iso:match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
  if not y then return nil end
  local now = os.time()
  local secs = now - os.time({ year = y, month = mo, day = d, hour = h, min = mi, sec = s, isdst = false })
    - os.difftime(now, os.time(os.date("!*t", now)))
  if secs < 60 then return "now" end
  if secs < 3600 then return math.floor(secs / 60) .. "m ago" end
  if secs < 86400 then return math.floor(secs / 3600) .. "h ago" end
  return math.floor(secs / 86400) .. "d ago"
end

local function find(name)
  return vim.iter(holds or {}):find(function(h) return h.name == name end)
end

local function selected_hold() return selected and find(selected:match("^hold:(.*)$")) end

local function selected_wait()
  local id = selected and selected:match("^wait:(.*)$")
  return id and vim.iter(waiting or {}):find(function(s) return s.id == id end)
end

-- ● its secret is here or it says where, ◌ it says neither, ○ nothing holds it.
local function mark(h)
  if #list(h.brains) + #list(h.templates) == 0 then return "○" end
  if nil_if_null(h.secret) or nil_if_null(h.where) then return "●" end
  return "◌"
end

-- The holds a spawn waits on: its brain's and its template's.
local function held_by(s)
  local t = s.environment .. "/" .. s.template
  return vim.iter(holds or {}):filter(function(h)
    return vim.tbl_contains(list(h.brains), nil_if_null(s.brain)) or vim.tbl_contains(list(h.templates), t)
  end):map(function(h) return h.name end):totable()
end

-- What the page is sent.
local function state()
  return {
    buf = buf,
    waiting = vim.iter(waiting or {}):map(function(s)
      return {
        key = "wait:" .. s.id, id = s.id, brain = nil_if_null(s.brain), by = s.by, template = s.template, environment = s.environment,
        task = s.task, ago = ago(s.created), holds = held_by(s),
      }
    end):totable(),
    holds = vim.iter(holds or {}):map(function(h)
      return {
        key = "hold:" .. h.name, name = h.name, about = h.about ~= "" and h.about or nil, where = nil_if_null(h.where),
        secret = ago(nil_if_null(h.secret)), recorded = h.recorded, brains = list(h.brains), templates = list(h.templates), mark = mark(h),
      }
    end):totable(),
    selected = selected,
    asking = asking,
    problem = problem,
    loading = (not holds and not problem) or nil,
  }
end

local function render_text()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local s = state()
  local lines, map = { "Holds" .. string.rep(" ", 41) .. "a new hold · R refresh · q close", "" }, {}
  local function field(label, value) table.insert(lines, string.format("    %-8s %s", label, value)) end
  if s.problem then table.insert(lines, "  " .. s.problem) end
  if s.loading then table.insert(lines, "  asking the Worker…") end
  if s.asking then table.insert(lines, "  " .. s.asking.what .. " " .. s.asking.name .. "?  y yes · n no") end
  if #s.waiting > 0 then
    table.insert(lines, "Waiting on you")
    for _, w in ipairs(s.waiting) do
      table.insert(lines, string.format("  %s wants %s%s  %s", w.by, w.brain or w.template, w.brain and (" on " .. w.template) or "", w.ago or ""))
      map[#lines] = w.key
      field("holds", table.concat(w.holds, " "))
      for _, l in ipairs(vim.split(vim.trim(w.task or ""), "\n")) do table.insert(lines, "    │ " .. l) end
      table.insert(lines, "    A approve · x deny · <CR> task")
      table.insert(lines, "")
    end
  end
  if not s.loading and not s.problem then
    table.insert(lines, "All")
    if #s.holds == 0 then table.insert(lines, "  No holds.") end
  end
  for _, h in ipairs(s.holds) do
    table.insert(lines, "  " .. h.mark .. " " .. h.name .. (h.recorded and "" or "  no record"))
    map[#lines] = h.key
    if h.about then table.insert(lines, "    " .. (h.about:match("^[^\n]*") or "")) end
    field("secret", h.secret and ("set " .. h.secret) or "none here")
    if h.where then field("where", h.where) end
    local by = vim.list_extend(vim.deepcopy(h.brains), vim.tbl_map(function(t) return t .. " (nix)" end, h.templates))
    field("held by", #by > 0 and table.concat(by, " ") or "nothing")
    table.insert(lines, "")
  end
  pinned.set_lines(buf, lines)
  line_item = map
  if not selected or not pinned.line_of(map, selected) then
    local first = vim.iter(vim.tbl_keys(map)):fold(math.huge, math.min)
    selected = map[first]
  end
  pinned.follow(buf, line_item, selected)
end

local function push_state()
  if buf and vim.api.nvim_buf_is_valid(buf) then require("corkboard").notify("corkboard.view", buf, state()) end
end

local function redraw()
  render_text()
  push_state()
end

function M.load()
  if not cloud().enabled() then
    problem = "holds need corkboard's bridge and the cloud"
    return redraw()
  end
  local ok, res = pcall(cloud().call, "brains_holds")
  if ok then
    holds, waiting, problem = list(res.holds), list(res.waiting), nil
  else
    problem = tostring(res)
  end
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

-- From the bridge: the user's socket (fleet.lua passes it on). A brain's
-- change may be what it holds, and a spawn's whether it still waits.
function M.cloud_event(event)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  if event.type == "brain" or event.type == "spawn" or event.type == "reconnected" then reload() end
end

-- A call, with a toast about what while the Worker answers; the answer, or nil.
local function act(op, verb, what, ...)
  local ui = require("corkboard")
  local id = "hold-" .. op .. "-" .. what
  ui.toast(id, "pending", verb .. " " .. what)
  local ok, res = pcall(cloud().call, op, ...)
  if ok then
    ui.toast(id, "done", verb .. " " .. what .. ": done")
  else
    ui.toast(id, "error", "couldn't " .. verb .. " " .. what .. ": " .. tostring(res))
  end
  reload()
  return ok and (res == nil and true or res) or nil
end

-- Saving --------------------------------------------------------------------
--
-- base: the hold as it was read, none for a new one; f: { name, about,
-- where, secret? } with secret a new value, vim.NIL to forget it, or absent
-- to keep it. One with no record is made under its name, then renamed.
-- What came of it: { name }, { stale, problem } with the hold as it is now,
-- or { problem }.

local function fields(h)
  return {
    name = h.name, about = h.about or "", where = nil_if_null(h.where), secret = ago(nil_if_null(h.secret)),
    recorded = h.recorded ~= false, updated = nil_if_null(h.updated), templates = list(h.templates),
  }
end

local function save(base, f)
  local body = { about = f.about or "", where = (f.where and f.where ~= "") and f.where or vim.NIL }
  if f.secret ~= nil then body.secret = f.secret end
  local ok, res
  if not base or not base.recorded then
    local name = base and base.name or f.name
    ok, res = pcall(cloud().call, "brains_hold_create", vim.tbl_extend("force", body, { name = name }))
    if ok and f.name ~= name then
      ok, res = pcall(cloud().call, "brains_hold_update", name, { updated = res.updated, name = f.name })
    end
  else
    body.updated = base.updated
    if f.name ~= base.name then body.name = f.name end
    ok, res = pcall(cloud().call, "brains_hold_update", base.name, body)
  end
  reload()
  if not ok then return { problem = tostring(res) } end
  if res.stale then
    local now = fields(res.stale)
    now.templates = base and base.templates or {}
    return { stale = now, problem = (nil_if_null(res.error) or "it changed since") .. "; this is it now" }
  end
  selected = "hold:" .. res.name
  return { name = res.name }
end

-- The page's form's save (web/src/components/HoldForm.tsx).
function M.save(base, f)
  base = nil_if_null(base)
  return save(base, f)
end

-- A hold as lines, `key: value`, what it's for last and as long as it likes.
local function to_lines(h)
  local out = { "name: " .. (h.name or ""), "where: " .. (nil_if_null(h.where) or ""), "about:" }
  vim.list_extend(out, vim.split(h.about or "", "\n"))
  return out
end

local function from_lines(lines)
  local f, about, at = {}, {}, false
  for _, l in ipairs(lines) do
    if at then
      table.insert(about, l)
    elseif l:match("^about:") then
      at = true
      local rest = vim.trim(l:sub(#"about:" + 1))
      if rest ~= "" then table.insert(about, rest) end
    else
      local k, v = l:match("^(%w+):%s*(.-)%s*$")
      if k then f[k] = v end
    end
  end
  return { name = f.name or "", where = f.where or "", about = vim.trim(table.concat(about, "\n")) }
end

local function edit(h)
  local base = h and fields(h)
  local e = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(e, "agent://hold/" .. (h and h.name or "new"))
  vim.bo[e].buftype = "acwrite"
  vim.bo[e].bufhidden = "wipe"
  vim.api.nvim_buf_set_lines(e, 0, -1, false, to_lines(base or {}))
  vim.bo[e].modified = false
  vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = e,
    callback = function()
      local f = from_lines(vim.api.nvim_buf_get_lines(e, 0, -1, false))
      if base and #base.templates > 0 and f.name ~= base.name then
        return vim.notify("corkboard: " .. table.concat(base.templates, ", ") .. " hold " .. base.name .. " in Nix; rename it there", vim.log.levels.WARN)
      end
      local res = save(base, f)
      if res.stale then
        vim.notify("corkboard: " .. res.problem, vim.log.levels.WARN)
        base = res.stale
        vim.api.nvim_buf_set_lines(e, 0, -1, false, to_lines(base))
        vim.bo[e].modified = false
        return
      end
      if res.problem then return vim.notify("corkboard: " .. res.problem, vim.log.levels.WARN) end
      vim.bo[e].modified = false
      vim.api.nvim_buf_delete(e, { force = true })
    end,
  })
  vim.cmd("botright split")
  vim.api.nvim_win_set_buf(0, e)
end

local function form(h)
  local corkboard = require("corkboard")
  if not corkboard.attached() then return edit(h) end
  corkboard.notify("corkboard.hold_form", { hold = h and fields(h) or nil })
end

function M.new() form(nil) end

function M.edit()
  local h = selected_hold()
  if h then form(h) end
end

-- The secret, typed unseen, for a bare Neovim (the form has its own field).
function M.secret()
  local h = selected_hold()
  if not h then return end
  local v = vim.fn.inputsecret("Secret for " .. h.name .. ": ")
  if v == "" then return end
  local res = save(fields(h), { name = h.name, about = h.about, where = nil_if_null(h.where), secret = v })
  if res.problem then vim.notify("corkboard: " .. res.problem, vim.log.levels.WARN) end
end

local function ask(what)
  local h = selected_hold()
  if not h then return end
  if what == "forget" and not nil_if_null(h.secret) then return end
  if what == "delete" and #list(h.templates) > 0 then
    return vim.notify("corkboard: " .. table.concat(h.templates, ", ") .. " hold " .. h.name .. " in Nix; take it out there")
  end
  asking = { name = h.name, what = what }
  redraw()
end

function M.delete() ask("delete") end
function M.forget() ask("forget") end

function M.answer(yes)
  local a = asking
  asking = nil
  redraw()
  if not (a and yes) then return end
  if a.what == "delete" then
    act("brains_hold_delete", "deleting", a.name, a.name)
  elseif a.what == "forget" then
    local h = find(a.name)
    if h then act("brains_hold_update", "forgetting the secret of", a.name, a.name, { updated = h.updated, secret = vim.NIL }) end
  end
end

-- Forgetting from the form: at once, as the form shows it gone.
function M.forget_now(name, updated)
  local ok, res = pcall(cloud().call, "brains_hold_update", name, { updated = updated, secret = vim.NIL })
  reload()
  if not ok then return { problem = tostring(res) } end
  if res.stale then return { stale = fields(res.stale), problem = (nil_if_null(res.error) or "it changed since") .. "; this is it now" } end
  return { hold = fields(res) }
end

function M.approve()
  local s = selected_wait()
  if s then act("fleet_approve", "approving", nil_if_null(s.brain) or s.template, s.id) end
end

function M.deny()
  local s = selected_wait()
  if s then act("fleet_stop", "denying", nil_if_null(s.brain) or s.template, s.id) end
end

-- A waiting spawn's task in full, below.
local function task(s)
  local name = "agent://holds/task/" .. s.id
  local old = vim.fn.bufnr(name)
  if old ~= -1 then pcall(vim.api.nvim_buf_delete, old, { force = true }) end
  local t = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(t, name)
  vim.bo[t].bufhidden = "wipe"
  vim.bo[t].filetype = "markdown"
  vim.api.nvim_buf_set_lines(t, 0, -1, false, vim.split(s.task or "", "\n"))
  vim.bo[t].modifiable = false
  vim.keymap.set("n", "q", "<Cmd>close<CR>", { buffer = t, nowait = true, desc = "holds: close" })
  vim.cmd("botright split")
  vim.api.nvim_win_set_buf(0, t)
end

function M.open()
  local s = selected_wait()
  if s then return task(s) end
  M.edit()
end

local function or_answer(yes, otherwise)
  return function()
    if asking then return M.answer(yes) end
    if otherwise then otherwise() end
  end
end

-- A click on an item in the browser; a button there names what to do.
function M.select(key, win, what)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(line_item, key)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
  if selected ~= key then
    selected = key
    if asking and "hold:" .. asking.name ~= key then asking = nil end
    redraw()
  end
  local f = ({ open = M.open, edit = M.edit, delete = M.delete, forget = M.forget, approve = M.approve, deny = M.deny })[what]
  if f then f() end
end

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  buf = pinned.listing("agent://holds", "holds", {
    j = { function() pinned.step(line_item, 1) end, "next" },
    k = { function() pinned.step(line_item, -1) end, "previous" },
    ["<CR>"] = { or_answer(true, M.open), "edit it, or open the task" },
    a = { M.new, "a new hold" },
    e = { M.edit, "edit it" },
    d = { M.delete, "delete it" },
    s = { M.secret, "set its secret" },
    S = { M.forget, "forget its secret" },
    A = { M.approve, "approve the spawn" },
    x = { M.deny, "deny the spawn" },
    y = { or_answer(true), "yes" },
    n = { or_answer(false), "no" },
    ["<Esc>"] = { or_answer(false), "no" },
    R = { M.load, "refresh" },
    q = { "<Cmd>close<CR>", "close" },
  }, function() return line_item end, function(key)
    if key == selected then return end
    selected = key
    if asking and "hold:" .. asking.name ~= key then asking = nil end
    redraw()
  end)
  vim.bo[buf].bufhidden = "hide"
  vim.api.nvim_create_autocmd("BufEnter", { buffer = buf, callback = function() vim.schedule(M.load) end })
  return buf
end

-- The holds, beside the brains view (or wherever it's open already).
function M.show()
  local b = buffer()
  local win = vim.fn.win_findbuf(b)[1]
  if win then
    vim.api.nvim_set_current_win(win)
  else
    vim.cmd("botright vsplit")
    vim.api.nvim_win_set_buf(0, b)
  end
  M.load()
end

function M.push_all() push_state() end

M.state = state
M.from_lines = from_lines
M.to_lines = to_lines

return M
