-- The Meetings tab (View > Meetings, or :AgentMeetings): the meetings
-- recorded on the bridge's machine (bridge/record.ts), newest first, the
-- selected one's transcript and proposed action items, and starting and
-- stopping the recorder. Each meeting goes to Pepper once it's transcribed,
-- and its action items become cards when they're accepted (propose.ts).
--
-- A plain listing, agent://meetings, with the browser's HTML drawn over it.
-- The cursor's line selects a meeting; m starts or stops recording, r
-- finishes one whose transcript didn't reach Pepper, and p proposes its
-- action items again.
--
-- What it shows is read from the files the recorder writes (meeting.json in
-- each meeting's directory, recording.json while one is recording), every
-- POLL_MS while the tab is shown.

local pinned = require("corkboard.pinned")

local M = {}

local POLL_MS = 500
local WHO = { out = "Them", ["in"] = "Me" }

local function ui() return require("corkboard") end

-- Who said a line: the name the recorder gave its voice, else its track's.
local function who(m, l)
  local names = m.who and m.who[l.track]
  local name = names and names[(l.speaker or 0) + 1]
  return name and name ~= "" and name or WHO[l.track] or l.track
end

-- What's being said, not yet a line, on each track: { track, start, text }.
local function partials(m)
  local list = {}
  for _, track in ipairs({ "out", "in" }) do
    local p = m.partial and m.partial[track]
    if p and p.text and p.text ~= "" then table.insert(list, { track = track, start = p.start, text = p.text }) end
  end
  table.sort(list, function(a, b) return a.start < b.start end)
  return list
end

-- How to run `corkboard-bridge record`, as a JSON list (the bridge's
-- CORKBOARD_RECORD_COMMAND); nil when Neovim isn't the bridge's.
local function record_command()
  local ok, given = pcall(vim.json.decode, vim.env.CORKBOARD_RECORD_COMMAND or "")
  return ok and type(given) == "table" and given or nil
end

local function record(args, done)
  local cmd = record_command()
  if not cmd then return done and done(false, "recording needs corkboard's bridge on this machine") end
  vim.system(vim.list_extend(vim.deepcopy(cmd), args), { text = true }, vim.schedule_wrap(function(res)
    if done then done(res.code == 0, vim.trim(res.code == 0 and res.stdout or res.stderr)) end
  end))
end

local function alive(pid) return type(pid) == "number" and vim.uv.kill(pid, 0) == 0 end

local function read_json(path)
  local f = io.open(path)
  if not f then return nil end
  local ok, t = pcall(vim.json.decode, f:read("*a"), { luanil = { object = true } })
  f:close()
  return ok and type(t) == "table" and t or nil
end

-- 7:24pm, as the day plan shows times.
local function clock(t) return (os.date("%I:%M%p", t):gsub("^0", ""):lower()) end

-- 03:12, from the meeting's start.
local function offset(ms)
  local s = math.floor(ms / 1000)
  if s >= 3600 then return ("%d:%02d:%02d"):format(math.floor(s / 3600), math.floor(s / 60) % 60, s % 60) end
  return ("%02d:%02d"):format(math.floor(s / 60), s % 60)
end

-- 2026-11-03T14:03:07.000Z as a time.
local function epoch(iso)
  local y, mo, d, h, mi, s = (iso or ""):match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
  if not y then return nil end
  local t = os.time({ year = y, month = mo, day = d, hour = h, min = mi, sec = s })
  -- os.time read it as local time; it was UTC.
  local now = os.time()
  return t + os.difftime(now, os.time(os.date("!*t", now)))
end

-- The recording that's running, if one is: { id, at }.
function M.current()
  local state = vim.env.CORKBOARD_STATE_DIR
  local r = state and read_json(state .. "/recording.json")
  return r and alive(r.pid) and r or nil
end

-- Read --------------------------------------------------------------------------

local cache = {} -- id -> { mtime, meeting }

local function meetings()
  local data = vim.env.CORKBOARD_DATA_DIR
  if not data then return {} end
  local root, list, seen = data .. "/meetings", {}, {}
  for name, type in vim.fs.dir(root) do
    local file = root .. "/" .. name .. "/meeting.json"
    local stat = type == "directory" and vim.uv.fs_stat(file)
    if stat then
      local mtime = stat.mtime.sec * 1e9 + stat.mtime.nsec
      local c = cache[name]
      if not c or c.mtime ~= mtime then
        c = { mtime = mtime, meeting = read_json(file) }
        cache[name] = c
      end
      if c.meeting then
        seen[name] = true
        table.insert(list, c.meeting)
      end
    end
  end
  for id in pairs(cache) do
    if not seen[id] then cache[id] = nil end
  end
  table.sort(list, function(a, b) return a.id > b.id end)
  return list
end

-- recording, transcribing, sent, failed or interrupted.
local function status(m, recording)
  if recording and recording.id == m.id then return "recording" end
  if m.sent then return "sent" end
  if alive(m.pid) then return "transcribing" end
  if not m.stopped then return "interrupted" end
  return "failed"
end

local function status_text(m, s)
  if s == "sent" then return "sent to " .. (m.brain == "pepper" and "Pepper" or m.brain) end
  if s == "failed" then return m.failed or "not sent" end
  return s
end

local function minutes(m)
  local a, b = epoch(m.started), m.stopped and epoch(m.stopped) or os.time()
  return a and math.max(0, math.floor((b - a) / 60 + 0.5)) or 0
end

local function when(m)
  local t = epoch(m.started)
  return t and (os.date("%a %d %b ", t) .. clock(t)) or m.id
end

-- The view -------------------------------------------------------------------

local buf
local line_id = {} -- line number -> meeting id
local selected
local list, recording = {}, nil
local last -- what was pushed last, to push only what changed
local pending -- "starting" or "stopping", until the recorder has
local working = {} -- meeting id -> "proposing" or "accepting", while it is

local proposals

local function find(id)
  for _, m in ipairs(list) do
    if m.id == id then return m end
  end
end

-- A meeting's proposals that weren't turned down, each with its index.
function proposals(m)
  local list = {}
  for i, p in ipairs(m.proposals) do
    if not p.dropped then
      local board, id = (p.card or ""):match("^(.-)/([^/]+)$")
      table.insert(list, {
        i = i - 1,
        title = p.title,
        description = p.description,
        owner = p.owner,
        board = p.board or vim.NIL,
        at = offset(p.at),
        quote = p.quote,
        card = id or vim.NIL,
        on = board or vim.NIL,
      })
    end
  end
  return list
end

-- What's not there is null rather than left out: the page keeps a view's
-- last state's fields that a new one doesn't have.
local function state()
  local m = find(selected)
  return {
    available = record_command() ~= nil,
    recording = recording and { id = recording.id, at = recording.at, since = clock(math.floor(recording.at / 1000)) } or vim.NIL,
    pending = pending or vim.NIL,
    selected = selected or vim.NIL,
    meetings = vim.tbl_map(function(x)
      local s = status(x, recording)
      return { id = x.id, when = when(x), minutes = minutes(x), status = s, detail = status_text(x, s), said = #(x.lines or {}) }
    end, list),
    transcript = m and vim.tbl_map(function(l)
      return { track = l.track, speaker = l.speaker or 0, who = who(m, l), at = offset(l.start), text = l.text }
    end, m.lines or {}) or vim.NIL,
    partial = m and vim.tbl_map(function(p)
      return { track = p.track, at = offset(p.start), text = p.text }
    end, partials(m)) or vim.NIL,
    proposals = m and m.proposals and proposals(m) or vim.NIL,
    boards = m and m.boards or vim.NIL,
    working = m and (working[m.id] or (alive(m.pid) and m.sent and not m.proposed and "proposing")) or vim.NIL,
    unproposed = m and m.unproposed or vim.NIL,
  }
end

local function render_text()
  local lines, map = { "Meetings" .. (recording and ("  ● recording since " .. clock(math.floor(recording.at / 1000))) or "") }, {}
  for _, m in ipairs(list) do
    table.insert(lines, ("  %-22s %4d min  %s"):format(when(m), minutes(m), status_text(m, status(m, recording))))
    map[#lines] = m.id
  end
  local m = find(selected)
  local said = m and partials(m) or {}
  if m and ((m.lines and #m.lines > 0) or #said > 0) then
    table.insert(lines, "")
    for _, l in ipairs(m.lines or {}) do
      table.insert(lines, ("  [%s] %s: %s"):format(offset(l.start), who(m, l), l.text))
    end
    for _, p in ipairs(said) do
      table.insert(lines, ("  [%s] %s… %s"):format(offset(p.start), WHO[p.track], p.text))
    end
  end
  local items = m and m.proposals and proposals(m) or {}
  if #items > 0 then
    table.insert(lines, "")
    table.insert(lines, "  Action items")
    for _, p in ipairs(items) do
      local where = p.card ~= vim.NIL and (p.card .. " on " .. p.on) or (p.board ~= vim.NIL and p.board or "")
      table.insert(lines, ("  %s %s (%s) %s"):format(p.card ~= vim.NIL and "✓" or "·", p.title, p.owner, where))
    end
  end
  pinned.set_lines(buf, lines)
  line_id = map
  if selected then pinned.follow(buf, line_id, selected) end
end

local function shown() return buf and vim.api.nvim_buf_is_valid(buf) and #vim.fn.win_findbuf(buf) > 0 end

local function push(force)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  list, recording = meetings(), M.current()
  if not find(selected) then selected = list[1] and list[1].id end
  local s = state()
  local key = vim.json.encode(s)
  if not force and key == last then return end
  last = key
  render_text()
  ui().notify("corkboard.view", buf, s)
end

local timer
local function poll()
  if timer then return end
  timer = vim.uv.new_timer()
  timer:start(POLL_MS, POLL_MS, vim.schedule_wrap(function()
    if not shown() then
      timer:stop()
      timer:close()
      timer = nil
      return
    end
    push()
  end))
end

-- Start recording a meeting, or stop the one that is. done(), once it has.
-- The button says it's starting or stopping until then.
function M.toggle(done)
  if pending then return end
  local op = M.current() and "stop" or "start"
  pending = op == "stop" and "stopping" or "starting"
  push()
  record({ op }, function(ok, out)
    pending = nil
    if not ok then vim.notify("corkboard: " .. out, vim.log.levels.ERROR) end
    push()
    if done then done() end
  end)
end

-- Transcribe what's left of a meeting and send it, when nothing else is.
function M.finish(id)
  local m = find(id or selected)
  local s = m and status(m, recording)
  if s ~= "failed" then return end
  record({ "finish", vim.env.CORKBOARD_DATA_DIR .. "/meetings/" .. m.id }, function(ok, out)
    if not ok then vim.notify("corkboard: " .. out, vim.log.levels.ERROR) end
    push()
  end)
  -- It says it's transcribing once it has started.
  vim.defer_fn(push, 300)
end

-- An op on a meeting's proposals (record propose, accept or drop), saying
-- what it's doing until it's done.
local function act(m, what, args)
  if working[m.id] then return end
  working[m.id] = what
  push()
  record(vim.list_extend({ args[1], vim.env.CORKBOARD_DATA_DIR .. "/meetings/" .. m.id }, vim.list_slice(args, 2)), function(ok, out)
    working[m.id] = nil
    if not ok then vim.notify("corkboard: " .. out, vim.log.levels.ERROR) end
    push()
  end)
end

-- Propose a meeting's action items again.
function M.propose(id)
  local m = find(id or selected)
  if m and m.transcribed and not alive(m.pid) then act(m, "proposing", { "propose" }) end
end

-- Make proposals cards: picks is a list of { i, board, title }.
function M.accept(id, picks)
  local m = find(id)
  if m and #picks > 0 then act(m, "accepting", { "accept", vim.json.encode(picks) }) end
end

-- Turn proposal i down.
function M.drop(id, i)
  local m = find(id)
  if m then act(m, "dropping", { "drop", tostring(i) }) end
end

-- A click on a meeting: the cursor to it, in the window clicked in.
function M.select(id, win)
  selected = id
  local lnum = pinned.line_of(line_id, id)
  if lnum and vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_set_cursor(win, { lnum, 2 }) end
  push(true)
end

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  buf = pinned.listing("agent://meetings", "meetings", {
    j = { function() pinned.step(line_id, 1) end, "next meeting" },
    k = { function() pinned.step(line_id, -1) end, "previous meeting" },
    m = { function() M.toggle() end, "record a meeting, or stop" },
    r = { function() M.finish() end, "send it to Pepper again" },
    p = { function() M.propose() end, "propose its action items again" },
  }, function() return line_id end, function(id)
    if id == selected then return end
    selected = id
    push(true)
  end)
  vim.api.nvim_create_autocmd("BufWinEnter", { buffer = buf, callback = function() poll() end })
  return buf
end

-- The tab, a new one after this, or where it's open.
function M.open()
  local b = buffer()
  local win = vim.fn.win_findbuf(b)[1]
  if win then
    vim.api.nvim_set_current_win(win)
  else
    vim.cmd("tabnew")
    local empty = vim.api.nvim_get_current_buf()
    vim.api.nvim_win_set_buf(0, b)
    pcall(vim.api.nvim_buf_delete, empty, {})
  end
  push(true)
  poll()
end

-- For a channel that just attached.
function M.push_all() push(true) end

function M.setup()
  vim.api.nvim_create_user_command("AgentMeetings", M.open, { desc = "corkboard: meetings" })
end

return M
