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
  local project = vim.fs.basename(require("corkboard.util").project_root(vim.fn.getcwd(-1, -1)))
  local list = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    -- One in a VM: what its VM says, or before that, there while its terminal is.
    local vm = vim.b[buf].corkboard_vm
    local state = vim.b[buf].corkboard_claude and terminal.alive(buf) and (agents.state(buf) or (vm and (vm_state(vm, buf) or "attached")))
    if state then
      table.insert(list, {
        buf = buf,
        project = project,
        name = require("corkboard.claude").title(buf),
        state = state,
        detail = vim.b[buf].corkboard_asking,
        typed = vim.b[buf].corkboard_typed,
        vm = vim.b[buf].corkboard_vm,
        -- For the fleet view's hover.
        role = vim.b[buf].corkboard_claude,
        card = vim.b[buf].corkboard_card,
        session = vim.b[buf].corkboard_claude_session,
        context = vim.b[buf].corkboard_context,
        -- Its log, which the phone draws the conversation from (bridge/remote.ts).
        transcript = vim.b[buf].corkboard_claude_transcript,
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
  return vim.api.nvim_buf_is_valid(buf) and vim.b[buf].corkboard_claude and terminal.alive(buf)
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

-- Text typed into it, then keys. Text of more than a line goes as a paste,
-- or its newlines would send it; the keys come a moment after, or Claude Code
-- takes them as more of the text.
function M.say(q, buf, text, keys)
  if not live(buf) then return answer(q, { error = "that session has ended", missing = true }) end
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
