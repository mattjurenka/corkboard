-- A Claude Code session's terminal, mirrored to another Neovim: the browser's,
-- or another machine's, through the Worker. The session's Neovim (the host)
-- sends what its terminal drew so far (corkboard.vt) and then every byte
-- its process prints; the viewer draws them in a terminal of its own,
-- agent://terminal/<bridge>/<key>, and sends back what's typed into it.
--
-- One process has one size, so it takes the size of whichever side was
-- last focused or typed into, and redraws for it: the other side's view is
-- off until it's focused again.
--
-- The bytes go host_* (bridge/remote.ts) -> "terminal" on corkboard.away ->
-- the bridge's stream (bridge/sessions.ts) -> the Worker -> the viewer's
-- fleet_terminal socket (bridge/cloud-session.ts) -> M.event.

local terminal = require("corkboard.terminal")
local vt = require("corkboard.vt")

local M = {}

-- What goes in one message: well under a socket message's limit once it's
-- base64.
local CHUNK = 48 * 1024

local function live(buf) return buf and vim.api.nvim_buf_is_valid(buf) and terminal.alive(buf) end

-- The host -----------------------------------------------------------------------

-- The bridge's channel, Neovim's stdio.
local function channel()
  for _, chan in ipairs(vim.api.nvim_list_chans()) do
    if chan.stream == "stdio" and chan.mode == "rpc" then return chan.id end
  end
end

-- By stream: { buf, rows, cols }, the size once the viewer says it.
local hosted = {}
-- By buf: the stream whose size its process has; nil, its own window's.
local owner = {}
-- By buf: its output since the last send.
local pending = {}

local function send(stream, bytes)
  local chan = channel()
  if not chan then return end
  for i = 1, #bytes, CHUNK do
    pcall(vim.rpcnotify, chan, "corkboard.away", "terminal", stream, vim.base64.encode(bytes:sub(i, i + CHUNK - 1)))
  end
end

local function finish(stream, why)
  hosted[stream] = nil
  local chan = channel()
  if chan then pcall(vim.rpcnotify, chan, "corkboard.away", "terminal", stream, vim.NIL, why) end
end

local function flush(buf)
  local parts = pending[buf]
  pending[buf] = nil
  if not parts then return end
  local bytes = table.concat(parts)
  for stream, h in pairs(hosted) do
    if h.buf == buf then send(stream, bytes) end
  end
end

-- From its on_stdout (corkboard.session), the way jobstart splits it.
function M.output(buf, data)
  if not vim.iter(pairs(hosted)):any(function(_, h) return h.buf == buf end) then return end
  if not pending[buf] then
    pending[buf] = {}
    vim.defer_fn(function() flush(buf) end, 10)
  end
  table.insert(pending[buf], table.concat(data, "\n"))
end

local function resize(buf, rows, cols)
  if rows and rows > 0 and cols > 0 and live(buf) then pcall(vim.fn.jobresize, terminal.job(buf), cols, rows) end
end

-- The process takes stream's size. Told again with every key: Neovim
-- puts its own back when its windows change, and the same size again
-- costs the process nothing (no SIGWINCH).
local function take(stream)
  local h = hosted[stream]
  if not (h and h.rows) then return end
  owner[h.buf] = stream
  vt.told(h.buf, h.rows, h.cols)
  resize(h.buf, h.rows, h.cols)
end

-- The process takes its own window's size again.
local function give_back(buf)
  if not owner[buf] then return end
  owner[buf] = nil
  vt.told(buf)
  local win = vim.fn.win_findbuf(buf)[1]
  if win then resize(buf, vim.api.nvim_win_get_height(win), vim.api.nvim_win_get_width(win) - vim.fn.getwininfo(win)[1].textoff) end
end

function M.host_open(stream, buf)
  if not live(buf) then return finish(stream, "that session has ended") end
  -- What's waiting is drawn already, in what it starts with.
  flush(buf)
  hosted[stream] = { buf = buf }
  local drawn = vt.ansi(buf)
  if drawn then send(stream, drawn) end
end

-- What's typed into the mirror, base64: it has the say from then on.
function M.host_input(stream, data)
  local h = hosted[stream]
  if not h then return end
  if not live(h.buf) then return finish(stream, "that session has ended") end
  take(stream)
  vim.fn.chansend(terminal.job(h.buf), vim.base64.decode(data))
end

function M.host_size(stream, rows, cols, focus)
  local h = hosted[stream]
  if not h then return end
  h.rows, h.cols = rows, cols
  if focus or owner[h.buf] == stream then take(stream) end
end

function M.host_close(stream)
  local h = hosted[stream]
  hosted[stream] = nil
  if h and owner[h.buf] == stream then give_back(h.buf) end
end

-- From its TermClose.
function M.ended(buf)
  owner[buf], pending[buf] = nil, nil
  for stream, h in pairs(hosted) do
    if h.buf == buf then finish(stream, "that session has ended") end
  end
end

-- Back here: the terminal is its own window's size again.
vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter", "FocusGained", "TermEnter" }, {
  group = vim.api.nvim_create_augroup("corkboard.mirror", {}),
  callback = function()
    local buf = vim.api.nvim_get_current_buf()
    if owner[buf] then give_back(buf) end
  end,
})

-- The viewer ------------------------------------------------------------------------

local function cloud() return require("corkboard.cards.cloud") end

-- By "bridge/key": { bridge, key, buf, chan }.
local views = {}

local function size(v, focus)
  local win = vim.fn.win_findbuf(v.buf)[1]
  if not win then return end
  cloud().send("fleet_terminal_send", v.bridge, v.key, {
    type = "size",
    rows = vim.api.nvim_win_get_height(win),
    cols = vim.api.nvim_win_get_width(win) - vim.fn.getwininfo(win)[1].textoff,
    focus = focus,
  })
end

local function connect(v)
  v.ended = false
  -- Over what was there: it starts with all of it again.
  vim.api.nvim_chan_send(v.chan, "\27c")
  local ok, err = pcall(cloud().call, "fleet_terminal", v.bridge, v.key)
  if not ok then return M.event({ type = "terminal_end", bridge = v.bridge, key = v.key, why = tostring(err) }) end
  size(v, true)
end

-- Open a session's terminal in a tab, or go to it if it's open.
function M.open(bridge, key, name)
  local id = bridge .. "/" .. key
  local v = views[id]
  if v and vim.api.nvim_buf_is_valid(v.buf) then return terminal.focus(v.buf) end
  vim.cmd.tabnew()
  local buf = vim.api.nvim_get_current_buf()
  v = { bridge = bridge, key = key, buf = buf }
  views[id] = v
  v.chan = vim.api.nvim_open_term(buf, {
    on_input = function(_, _, _, data)
      if not v.ended then cloud().send("fleet_terminal_send", bridge, key, { type = "in", data = vim.base64.encode(data) }) end
    end,
  })
  pcall(vim.api.nvim_buf_set_name, buf, "agent://terminal/" .. id)
  vim.bo[buf].bufhidden = "wipe"
  vim.b[buf].corkboard_name = name
  vim.wo.number = false
  vim.wo.relativenumber = false
  vim.wo.signcolumn = "no"
  vim.keymap.set("n", "R", function() connect(v) end, { buffer = buf, desc = "corkboard: connect to it again" })
  vim.keymap.set("n", "q", function() vim.cmd.close() end, { buffer = buf, desc = "corkboard: close the terminal" })

  local group = vim.api.nvim_create_augroup("corkboard.mirror." .. buf, {})
  vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter" }, { group = group, buffer = buf, callback = function() size(v, true) end })
  vim.api.nvim_create_autocmd("FocusGained", {
    group = group,
    callback = function()
      if vim.api.nvim_get_current_buf() == buf then size(v, true) end
    end,
  })
  vim.api.nvim_create_autocmd({ "WinResized", "VimResized" }, {
    group = group,
    callback = function()
      if vim.fn.win_findbuf(buf)[1] then size(v, vim.api.nvim_get_current_buf() == buf) end
    end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    buffer = buf,
    once = true,
    callback = function()
      views[id] = nil
      pcall(vim.api.nvim_del_augroup_by_id, group)
      cloud().send("fleet_unterminal", bridge, key)
    end,
  })
  connect(v)
  vim.cmd.startinsert()
end

-- From the bridge: its bytes, or its end.
function M.event(event)
  local v = views[tostring(event.bridge) .. "/" .. tostring(event.key)]
  if not (v and vim.api.nvim_buf_is_valid(v.buf)) then return end
  if event.type == "terminal_end" then
    if v.ended then return end
    v.ended = true
    local why = event.why ~= vim.NIL and event.why or "ended"
    return vim.api.nvim_chan_send(v.chan, "\r\n\27[2m" .. tostring(why) .. " (R to connect again)\27[0m")
  end
  vim.api.nvim_chan_send(v.chan, vim.base64.decode(event.data))
end

return M
