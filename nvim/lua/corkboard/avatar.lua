-- A Claude Code session with a face: an HTML panel (b:corkboard_view
-- "avatar", web/src/views/Avatar.tsx) beside the session, where a VRM model
-- says what Claude passes to the mod's say tool (claude-plugin/hooks/say.tsx)
-- as it comes, out loud and as subtitles; its replies stay written to be
-- read. The session's log (b:corkboard_agent_transcript) is followed here;
-- the page speaks what it hasn't seen before, so what was said before it
-- opened is only shown.
--
--   m   mute or unmute
--   s   stop what it's saying (and showing off)
--   d   show it off: its intro, a pat, two pokes and a treat
--
-- :Avatar opens it beside this tab's session, or closes it; :Avatar demo
-- shows it off, and :Avatar demo {persona}... (or all) shows them off in
-- turn, opening it if it isn't.

local M = {}

local KEEP = 20
local TEXT = 4000
local TAIL = 256 * 1024
local SAY = "mcp__corkboard-ui__say"
local EMOTE = "mcp__corkboard-ui__emote"

local panels = {} -- session buffer -> { buf, timer, path, offset, rest, said, muted, skip, demos, demo }

local function session_in_tab()
  local cur = vim.api.nvim_get_current_buf()
  if vim.b[cur].corkboard_agent then return cur, vim.api.nvim_get_current_win() end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local buf = vim.api.nvim_win_get_buf(win)
    if vim.b[buf].corkboard_agent and vim.api.nvim_win_get_config(win).relative == "" then return buf, win end
  end
end

-- What Claude said in one record of the log: its calls to say, and to
-- emote (an act, no words), not a subagent's.
local function said(line)
  local ok, r = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
  if not ok or type(r) ~= "table" or r.type ~= "assistant" or r.isSidechain or type(r.message) ~= "table" then return {} end
  local out = {}
  for i, b in ipairs(type(r.message.content) == "table" and r.message.content or {}) do
    local call = type(b) == "table" and b.type == "tool_use" and type(b.input) == "table"
    local text = call and b.name == SAY and b.input.text
    text = type(text) == "string" and vim.trim(text) or ""
    local emote = call and b.name == EMOTE and b.input.emote
    if type(emote) == "string" and emote ~= "" then
      table.insert(out, { id = b.id or ("%s:%d"):format(r.uuid or "", i), emote = emote })
    elseif text ~= "" then
      local mood = type(b.input.mood) == "string" and b.input.mood or nil
      table.insert(out, { id = b.id or ("%s:%d"):format(r.uuid or "", i), text = text:sub(1, TEXT), mood = mood })
    end
  end
  return out
end

-- Who the session's avatar is: its brain's persona, or the default brain's
-- for a session of the user's own.
local function persona(src)
  local ok, id = pcall(require("corkboard.brains").persona_of, vim.b[src].corkboard_brain)
  return require("corkboard.personas").id(ok and id or nil)
end

-- Skins for the default, one picked at random for each session.
local SKINS = { "#f6d7c3", "#eac0a2", "#d9a77f", "#c68c62", "#a86f4a", "#8a5537", "#6b3f28", "#4e2c1c" }

-- Its skin colour, if its brain gives one; with no persona, the default's
-- random one.
local function skin(src)
  local ok, id, colour = pcall(require("corkboard.brains").persona_of, vim.b[src].corkboard_brain)
  if ok and (id or colour) then return colour end
  vim.b[src].corkboard_skin = vim.b[src].corkboard_skin or SKINS[math.random(#SKINS)]
  return vim.b[src].corkboard_skin
end

-- The phone's face is the same one (away.lua).
M.persona = persona
M.skin = skin

local function push(src)
  local a = panels[src]
  if not a then return end
  require("corkboard").notify("corkboard.view", a.buf, {
    said = a.said,
    state = require("corkboard.agents").state(src) or "idle",
    muted = a.muted,
    skip = a.skip,
    persona = persona(src),
    -- null, not left out: the page keeps what a state leaves out.
    skin = skin(src) or vim.NIL,
    -- Sent once, so a panel come back to doesn't show off again.
    demo = a.demo or vim.NIL,
  })
  a.demo = nil
end

-- The page shows off the personas of, or its own.
local function demo(src, of)
  local a = panels[src]
  a.demos = a.demos + 1
  a.demo = { n = a.demos, of = #of > 0 and of or vim.NIL }
  push(src)
end

-- The log's new whole lines since the last read. A new log (a /clear)
-- starts over; the first read of one only remembers its last thing said.
local function read(src)
  local a = panels[src]
  local path = vim.b[src].corkboard_agent_transcript
  if not a then return end
  -- No log yet: all it says will be new.
  if not path then
    if not a.path then
      a.path = ""
      push(src)
    end
    return
  end
  path = vim.fn.expand(path)
  local first = a.path ~= path
  if first then a.path, a.offset, a.rest = path, 0, "" end
  local fd = vim.uv.fs_open(path, "r", 0)
  if not fd then return end
  local size = vim.uv.fs_fstat(fd).size
  -- A long log is only read from near its end, from its next whole line.
  local partial = first and size > TAIL
  if partial then a.offset = size - TAIL end
  local chunk = size > a.offset and vim.uv.fs_read(fd, size - a.offset, a.offset) or ""
  vim.uv.fs_close(fd)
  a.offset = size
  local text = a.rest .. (chunk or "")
  local lines = vim.split(text, "\n", { plain = true })
  a.rest = table.remove(lines)
  if partial then table.remove(lines, 1) end
  local new = {}
  for _, l in ipairs(lines) do
    vim.list_extend(new, said(l))
  end
  if first then a.said = {} end
  if #new == 0 and not first then return end
  vim.list_extend(a.said, new)
  while #a.said > KEEP do
    table.remove(a.said, 1)
  end
  push(src)
end

local function stop(src)
  local a = panels[src]
  if not a then return end
  panels[src] = nil
  if a.timer then
    a.timer:stop()
    a.timer:close()
  end
end

local function panel_buf(src)
  local a = panels[src]
  if a and vim.api.nvim_buf_is_valid(a.buf) then return a.buf end
  local p = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(p, "avatar://" .. src)
  vim.bo[p].filetype = "corkboard"
  vim.b[p].corkboard_view = "avatar"
  vim.b[p].corkboard_source = src
  a = { buf = p, said = {}, muted = false, skip = 0, demos = 0 }
  panels[src] = a
  vim.keymap.set("n", "m", function()
    a.muted = not a.muted
    push(src)
  end, { buffer = p, nowait = true, desc = "avatar: mute" })
  vim.keymap.set("n", "s", function()
    a.skip = a.skip + 1
    push(src)
  end, { buffer = p, nowait = true, desc = "avatar: stop talking" })
  vim.keymap.set("n", "d", function() demo(src, {}) end, { buffer = p, nowait = true, desc = "avatar: show it off" })
  a.timer = vim.uv.new_timer()
  a.timer:start(0, 400, vim.schedule_wrap(function() read(src) end))
  for _, b in ipairs({ src, p }) do
    vim.api.nvim_create_autocmd("BufWipeout", {
      buffer = b,
      once = true,
      callback = function()
        stop(src)
        vim.schedule(function()
          for _, win in ipairs(vim.api.nvim_buf_is_valid(p) and vim.fn.win_findbuf(p) or {}) do
            pcall(vim.api.nvim_win_close, win, true)
          end
          pcall(vim.api.nvim_buf_delete, p, { force = true })
        end)
      end,
    })
  end
  return p
end

-- Above the cards beside the session if they're there, else beside it;
-- with how it was (corkboard.restore): muted or not.
local function open(src, swin, was)
  local p = panel_buf(src)
  if was then panels[src].muted = was.muted == true end
  local cards
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.b[vim.api.nvim_win_get_buf(win)].corkboard_view == "cards" then cards = win end
  end
  local narrow = require("corkboard").narrow()
  local win
  if cards then
    win = vim.api.nvim_open_win(p, false, { split = "above", win = cards, height = math.floor(vim.api.nvim_win_get_height(cards) / 2) })
  elseif narrow then
    win = vim.api.nvim_open_win(p, false, { split = "below", win = swin, height = math.floor(vim.api.nvim_win_get_height(swin) / 2) })
  else
    win = vim.api.nvim_open_win(p, false, { split = "right", win = swin, width = math.min(56, math.floor(vim.o.columns / 3)) })
  end
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false
  vim.wo[win].signcolumn = "no"
  -- Its first read is what was said before; after that, what it has.
  if panels[src].path then push(src) else read(src) end
end

function M.toggle()
  local src, swin = session_in_tab()
  if not src then return vim.notify("corkboard: no Claude Code session in this tab") end
  local a = panels[src]
  local shown = a and vim.api.nvim_buf_is_valid(a.buf) and vim.tbl_filter(function(w)
    return vim.api.nvim_win_get_tabpage(w) == vim.api.nvim_get_current_tabpage()
  end, vim.fn.win_findbuf(a.buf)) or {}
  if #shown > 0 then
    for _, w in ipairs(shown) do
      pcall(vim.api.nvim_win_close, w, true)
    end
    return
  end
  open(src, swin)
end

M.open = open

-- :Avatar demo: this tab's session's face shows off the personas ids
-- ("all", each one), or its own; opened first if it isn't, with a moment
-- for its page to be there to see it.
function M.demo(ids)
  local src, swin = session_in_tab()
  if not src then return vim.notify("corkboard: no Claude Code session in this tab") end
  local personas = require("corkboard.personas")
  local of = {}
  for _, id in ipairs(ids) do
    if id == "all" then
      of = vim.list_extend({}, personas.IDS)
      break
    end
    if not vim.tbl_contains(personas.IDS, id) then return vim.notify("corkboard: no persona " .. id) end
    table.insert(of, id)
  end
  local a = panels[src]
  if a and vim.api.nvim_buf_is_valid(a.buf) and #vim.fn.win_findbuf(a.buf) > 0 then return demo(src, of) end
  open(src, swin)
  vim.defer_fn(function()
    if panels[src] then demo(src, of) end
  end, 1500)
end

-- How a session's panel is, if it's open in tab, for corkboard.restore to
-- keep.
function M.kept(src, tab)
  local a = panels[src]
  if not a or not vim.api.nvim_buf_is_valid(a.buf) then return nil end
  for _, w in ipairs(vim.fn.win_findbuf(a.buf)) do
    if vim.api.nvim_win_get_tabpage(w) == tab then return { muted = a.muted } end
  end
end

-- What a session said through corkboard-ui's own server (hooks/ui-mcp.lua),
-- for a kind whose log this doesn't read: { text, mood } or { emote }.
local said_n = 0
function M.say(src, item)
  local a = panels[src]
  if not a then return end
  said_n = said_n + 1
  table.insert(a.said, vim.tbl_extend("force", item, { id = "ui:" .. said_n }))
  while #a.said > KEEP do
    table.remove(a.said, 1)
  end
  push(src)
end

-- A session's state changed (corkboard.agents' hook): the face follows it.
function M.changed(src)
  if panels[src] then push(src) end
end

-- The brains were read, or changed: each face follows its persona.
function M.personas_changed()
  for src in pairs(panels) do
    push(src)
  end
end

-- Whether what the session says next is heard: its panel is open and not
-- muted. The session hook asks, to have it told to use say, and how its
-- persona talks: that, or false.
function M.heard(src)
  local a = panels[src]
  if not (a ~= nil and not a.muted and vim.api.nvim_buf_is_valid(a.buf) and #vim.fn.win_findbuf(a.buf) > 0) then return false end
  return require("corkboard.personas").speaks(persona(src))
end

function M.setup()
  vim.api.nvim_create_user_command("Avatar", function(o)
    if o.fargs[1] == "demo" then return M.demo(vim.list_slice(o.fargs, 2)) end
    M.toggle()
  end, {
    nargs = "*",
    complete = function(_, line)
      if not line:match("^%S+%s+demo%s") then return { "demo" } end
      return vim.list_extend({ "all" }, require("corkboard.personas").IDS)
    end,
    desc = "corkboard: a face for this tab's Claude Code session",
  })
end

return M
