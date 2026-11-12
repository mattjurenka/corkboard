-- Away mode (<leader>a, :AgentAway): every page goes dark but for the Claude
-- Code sessions of every project, and chimes when it's time to come back.
-- The bridge keeps it across pages (bridge/away.ts); this tells it what this
-- Neovim's sessions are doing, whenever that changes, and asks it to start.
-- It also answers the phone's questions of one (screen, say).

local terminal = require("corkboard.terminal")

local M = {}

-- The bridge's channel, Neovim's stdio; nil without one (a test, a script).
local function channel()
  for _, chan in ipairs(vim.api.nvim_list_chans()) do
    if chan.stream == "stdio" and chan.mode == "rpc" then return chan.id end
  end
end

-- One in a VM has no hooks here. Its VM publishes what its sessions are
-- doing, each with the terminal it's in (claude-ready-watch, into
-- /var/lib/<vm>/outbox, at least once a minute), once it's been talked to.
local VM_STATES = { busy = "working", idle = "idle", waiting = "permission" }
local watching = {}

local function vm_state(vm, buf)
  local dir = "/var/lib/" .. vm .. "/outbox"
  if not watching[vm] then
    local w = vim.uv.new_fs_event()
    if w and w:start(dir, {}, function(_, name) if name == ".claude-sessions.json" then vim.schedule(M.report) end end) then
      watching[vm] = w
    end
  end
  local path = dir .. "/.claude-sessions.json"
  local stat = vim.uv.fs_stat(path)
  if not stat or os.time() - stat.mtime.sec > 180 then return end
  local ok, reading = pcall(vim.json.decode, table.concat(vim.fn.readfile(path), "\n"))
  if not ok or type(reading) ~= "table" then return end
  for _, s in ipairs(reading.sessions or {}) do
    local at = s.corkboard
    if type(at) == "table" and at.buf == buf and at.nvim == require("corkboard.util").server() then return VM_STATES[s.status] end
  end
end

local function sessions()
  local agents = require("corkboard.agents")
  local avatar = require("corkboard.avatar")
  local project = vim.fs.basename(require("corkboard.util").project_root(vim.fn.getcwd(-1, -1)))
  local list = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    -- One in a VM: what its VM says, or before that, there while its terminal is.
    local vm = vim.b[buf].corkboard_vm
    local state = vim.b[buf].corkboard_agent and terminal.alive(buf) and (agents.state(buf) or (vm and (vm_state(vm, buf) or "attached")))
    if state then
      table.insert(list, {
        buf = buf,
        project = project,
        name = require("corkboard.session").title(buf),
        state = state,
        detail = vim.b[buf].corkboard_asking,
        typed = vim.b[buf].corkboard_typed,
        vm = vim.b[buf].corkboard_vm,
        -- For the fleet view's hover.
        role = vim.b[buf].corkboard_role,
        card = vim.b[buf].corkboard_card,
        session = vim.b[buf].corkboard_agent_session,
        context = vim.b[buf].corkboard_context,
        -- Its log, which the phone draws the conversation from (bridge/remote.ts).
        transcript = vim.b[buf].corkboard_agent_transcript,
        -- Its face on the phone (corkboard/avatar.lua's).
        persona = avatar.persona(buf),
        skin = avatar.skin(buf),
      })
    end
  end
  return list
end

local last

-- After a session's state changes, or it ends. Only a change is sent.
function M.report()
  local chan = channel()
  if not chan then return end
  local list = sessions()
  local encoded = vim.json.encode(list)
  if encoded == last then return end
  last = encoded
  pcall(vim.rpcnotify, chan, "corkboard.away", "report", list)
end

-- The phone's questions of a session, through the bridge (bridge/remote.ts):
-- each answered with "answer" and its number.

local function answer(q, a)
  local chan = channel()
  if chan then pcall(vim.rpcnotify, chan, "corkboard.away", "answer", q, a) end
end

local function live(buf)
  return vim.api.nvim_buf_is_valid(buf) and vim.b[buf].corkboard_agent and terminal.alive(buf)
end

-- What its terminal shows, the last 300 lines of it, and their colors
-- (corkboard.vt) where it knows them.
function M.screen(q, buf)
  if not live(buf) then return answer(q, { error = "that session has ended", missing = true }) end
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local total = #lines
  while #lines > 0 and lines[#lines]:match("^%s*$") do
    table.remove(lines)
  end
  local first = math.max(1, #lines - 299)
  lines = vim.tbl_map(function(l) return (l:gsub("%s+$", "")) end, vim.list_slice(lines, first))
  local win = vim.fn.win_findbuf(buf)[1]
  local vt = require("corkboard.vt")
  answer(q, { lines = lines, width = win and vim.api.nvim_win_get_width(win) or nil, colors = vt.colors(buf, lines, first, total), palette = vt.palette() })
end

local KEYS = { enter = "\r", esc = "\27", up = "\27[A", down = "\27[B", tab = "\t", ["shift-tab"] = "\27[Z", ["ctrl-c"] = "\3" }

-- An AskUserQuestion's answers ({ picks = { 0-based }, other = "its own
-- words" } for each question) as the keys Claude Code's dialog takes, from
-- its first question, each its own write. A single choice's number picks it
-- and moves on; a question of several choices ticks each by its number, then
-- goes down past its rows to Next. Its own words go in the row after the
-- options. With more than one question, or several choices, a review comes
-- last, whose first row submits. nil and why, for answers that don't fit.
function M.answer_keys(questions, answers)
  if type(questions) ~= "table" or #questions == 0 then return nil, "it isn't asking" end
  if type(answers) ~= "table" or #answers ~= #questions then return nil, "answer each question" end
  local out = {}
  local review = #questions > 1
  for i, q in ipairs(questions) do
    local a, n = answers[i], #(q.options or {})
    local picks = type(a) == "table" and type(a.picks) == "table" and a.picks or {}
    local other = type(a) == "table" and type(a.other) == "string" and vim.trim((a.other:gsub("%s+", " "))) or ""
    for _, p in ipairs(picks) do
      if type(p) ~= "number" or p % 1 ~= 0 or p < 0 or p >= n then return nil, "no such option" end
    end
    if q.multiSelect then
      review = true
      for _, p in ipairs(picks) do table.insert(out, tostring(p + 1)) end
      if other ~= "" then
        table.insert(out, tostring(n + 1))
        for _ = 1, n do table.insert(out, KEYS.down) end
        vim.list_extend(out, { other, KEYS.down })
      else
        for _ = 1, n + 1 do table.insert(out, KEYS.down) end
      end
      table.insert(out, KEYS.enter)
    elseif other ~= "" and #picks == 0 then
      vim.list_extend(out, { tostring(n + 1), other, KEYS.enter })
    elseif #picks == 1 and other == "" then
      table.insert(out, tostring(picks[1] + 1))
    else
      return nil, "pick one: " .. (q.header or q.question or "")
    end
  end
  if review then table.insert(out, "1") end
  return out
end

-- Text typed into it, then keys. Text of more than a line goes as a paste,
-- or its newlines would send it; the keys come a moment after, or Claude Code
-- takes them as more of the text. Or answers to what it asks, instead: they
-- go a key at a time, after it's told they will.
function M.say(q, buf, text, keys, answers)
  if not live(buf) then return answer(q, { error = "that session has ended", missing = true }) end
  if answers ~= nil and answers ~= vim.NIL then
    local writes, why = M.answer_keys(vim.b[buf].corkboard_questions, answers)
    if not writes then return answer(q, { error = why }) end
    answer(q, { ok = true })
    local chan = terminal.job(buf)
    local i = 0
    local function next()
      i = i + 1
      if not writes[i] or not terminal.alive(buf) then return end
      vim.fn.chansend(chan, writes[i])
      vim.defer_fn(next, 100)
    end
    return next()
  end
  local chan = terminal.job(buf)
  if text ~= "" then vim.fn.chansend(chan, text:find("\n") and ("\27[200~" .. text .. "\27[201~") or text) end
  local i = 0
  local function next()
    i = i + 1
    if not keys[i] then return answer(q, { ok = true }) end
    if KEYS[keys[i]] and terminal.alive(buf) then vim.fn.chansend(chan, KEYS[keys[i]]) end
    vim.defer_fn(next, 50)
  end
  vim.defer_fn(next, text ~= "" and 150 or 0)
end

function M.enter()
  local chan = channel()
  if not chan then return vim.notify("corkboard: away mode needs the bridge") end
  last = nil
  M.report()
  vim.rpcnotify(chan, "corkboard.away", "enter")
end

function M.setup()
  vim.keymap.set("n", "<leader>a", M.enter, { desc = "corkboard: away mode" })
  vim.api.nvim_create_user_command("AgentAway", M.enter, { desc = "corkboard: away mode" })
end

return M
