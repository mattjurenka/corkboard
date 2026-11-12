-- A session of an ACP agent (corkboard.agent's kinds with events = "acp"):
-- the agent runs under the bridge (bridge/acp.ts), and its session is a
-- buffer here, agent://acp/<buf>, in place of a terminal. Its events reach
-- corkboard.agents as a terminal session's hooks' do; its conversation (the
-- transcript's items, as the phone has them, and the words it's saying),
-- what it asks permission for and how its turns end come here, and are
-- drawn as a fleet session's are (corkboard.conversation, and the page's
-- views/Conversation.tsx over it).
--
--   i, a, o   say something
--   1-9       answer what it asks, or asks permission for
--   <CR>      a tool whole, or back to its line
--   <C-c>     stop the turn
--   q         close it

local M = {}

local function cloud() return require("corkboard.cards.cloud") end
local function conversation() return require("corkboard.conversation") end

-- By buf: { opts, kind, c (its conversation), asked = { id, p }, alive,
-- notes }.
local open = {}

-- What the conversation says it's doing, from what it waits on and
-- corkboard.agents' state.
local function state(buf, s)
  if s.asked then return "permission" end
  if require("corkboard.questions").pending(buf) then return "asking" end
  if s.alive == nil then return "starting" end
  local live = require("corkboard.agents").state(buf)
  if live == "working" or live == "background" then return "working" end
end

local function draw(buf)
  local s = open[buf]
  if not (s and vim.api.nvim_buf_is_valid(buf)) then return end
  s.c.state = state(buf, s)
  s.c.choices = s.asked and vim.tbl_map(function(o) return o.name end, s.asked.p.options) or nil
  conversation().draw(s.c)
end

-- A line of its own in the conversation: how a turn ended, or what went wrong.
local function note(s, text, err)
  s.notes = s.notes + 1
  table.insert(s.c.items, { kind = "note", id = "note:" .. s.notes, text = text, error = err or nil })
end

-- Asks the bridge to open its session: a fresh one, or opts.resume's.
local function connect(buf)
  local s = open[buf]
  local o = s.opts
  local mcp = {}
  if o.mcp then table.insert(mcp, o.mcp) end
  if vim.env.CORKBOARD_MEMORY_MCP_CONFIG then table.insert(mcp, vim.env.CORKBOARD_MEMORY_MCP_CONFIG) end
  local ui = require("corkboard.agent").ui_server(buf)
  local prompt = table.concat(vim.tbl_filter(function(p) return p ~= nil end, { require("corkboard.agent").PROMPT, o.prompt }), "\n\n")
  cloud().call_async("acp_start", function(err, got)
    if err then
      s.alive = false
      s.c.ended = "— ended"
      return M.failed(buf, err)
    end
    s.alive = true
    vim.b[buf].corkboard_acp_alive = true
    if type(got) == "table" and type(got.transcript) == "string" then vim.b[buf].corkboard_agent_transcript = got.transcript end
    draw(buf)
  end, buf, {
    kind = s.kind.name,
    cwd = vim.b[buf].corkboard_cwd,
    prompt = prompt,
    mcp = #mcp > 0 and mcp or nil,
    servers = ui and { ui } or nil,
    brain = o.brain,
    resume = o.resume,
    task = o.task,
  })
end

-- Starts kind's agent for corkboard.session.start (its opts), in buf.
function M.start(buf, kind, opts)
  local s = { opts = opts, kind = kind, notes = 0 }
  open[buf] = s
  vim.b[buf].corkboard_acp = true
  -- Where it runs, which restore.lua keeps.
  vim.b[buf].corkboard_cwd = vim.fs.normalize(opts.cwd or vim.fn.getcwd())
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = "corkboard-acp"
  pcall(vim.api.nvim_buf_set_name, buf, "agent://acp/" .. buf)
  s.c = conversation().attach(buf, {
    id = "acp/" .. buf,
    name = opts.name or kind.label,
    where = { brain = opts.brain, dir = vim.fn.fnamemodify(vim.b[buf].corkboard_cwd, ":~") },
    on = {
      say = function(text) M.prompt(buf, text) end,
      answer = function(n)
        local o = s.asked and s.asked.p.options[n]
        if o then M.answer(buf, o.optionId) end
      end,
      answers = function(answers)
        local ok, why = require("corkboard.questions").answer(buf, answers)
        if not ok then vim.notify("corkboard: " .. why, vim.log.levels.WARN) end
      end,
      interrupt = function() M.cancel(buf) end,
      close = function() M.stop(buf) end,
      gone = function() M.stop(buf, true) end,
    },
  })
  -- What corkboard.questions has it asking, which outlasts the tool call.
  s.c.questions = function() return require("corkboard.questions").pending(buf) end
  draw(buf)
  connect(buf)
  return buf
end

function M.alive(buf) return open[buf] ~= nil and open[buf].alive == true end

-- A prompt for its next turn. /clear: a new session in its place. While it
-- asks permission, an option's number answers it, as the phone sends one.
function M.prompt(buf, text)
  local s = open[buf]
  if not (s and s.alive) then return vim.notify("corkboard: that session has ended", vim.log.levels.WARN) end
  local n = s.asked and tonumber(vim.trim(text):match("^%d$"))
  if n then
    local o = s.asked.p.options[n]
    if o then return M.answer(buf, o.optionId) end
  end
  if vim.trim(text) == "/clear" then
    s.opts = vim.tbl_extend("force", s.opts, { resume = false, task = false })
    s.c.items, s.c.results, s.c.live, s.clearing = {}, {}, nil, true
    draw(buf)
    return connect(buf)
  end
  cloud().call_async("acp_prompt", function(err)
    if err then M.failed(buf, err) end
  end, buf, text)
end

function M.cancel(buf)
  if not M.alive(buf) then return end
  open[buf].asked = nil
  draw(buf)
  cloud().send("acp_cancel", buf)
end

-- The agent ended (q, or its buffer gone).
function M.stop(buf, gone)
  if not open[buf] then return end
  open[buf] = nil
  if cloud().enabled() then cloud().send("acp_stop", buf) end
  if not gone and vim.api.nvim_buf_is_valid(buf) then pcall(vim.api.nvim_buf_delete, buf, { force = true }) end
end

-- What's new in its conversation (bridge/acp.ts): the transcript's items
-- since the last, and the words it's saying that aren't in them yet.
function M.view(buf, items, live)
  local s = open[buf]
  if not s then return end
  local c = s.c
  local known = {}
  for _, t in ipairs(c.items) do known[t.id] = true end
  for _, t in ipairs(items or {}) do
    if t.kind == "result" then
      c.results[t.call] = t
    elseif not known[t.id] then
      table.insert(c.items, t)
    end
  end
  c.live = type(live) == "string" and live or nil
  draw(buf)
end

-- Its state changed (corkboard.agents).
function M.changed(buf)
  if open[buf] then draw(buf) end
end

-- What it asks permission for, answered in its conversation (or at the card).
function M.permission(buf, id, p)
  local s = open[buf]
  if not s then return cloud().send("acp_answer", buf, id, vim.NIL) end
  s.asked = { id = id, p = p }
  draw(buf)
end

-- Whether it waits on a permission's answer.
function M.asked(buf) return open[buf] ~= nil and open[buf].asked ~= nil end

function M.answer(buf, option)
  local s = open[buf]
  if not (s and s.asked) then return end
  local id = s.asked.id
  s.asked = nil
  draw(buf)
  cloud().send("acp_answer", buf, id, option or vim.NIL)
  require("corkboard.agents").hook({ buf = buf, event = "tool" })
end

function M.answer_prompt(buf)
  local s = open[buf]
  if not (s and s.asked) then return false end
  local p = s.asked.p
  vim.ui.select(p.options, {
    prompt = p.tool.name .. ": " .. p.tool.title,
    format_item = function(o) return o.name end,
  }, function(o)
    if o then M.answer(buf, o.optionId) end
  end)
  return true
end

-- A turn's end: its stopReason, when it's worth a word.
local STOPS = {
  cancelled = "— stopped",
  max_tokens = "✗ it ran out of tokens",
  max_turn_requests = "✗ it ran out of requests for the turn",
  refusal = "✗ it refused",
}

function M.settled(buf, stop)
  local s = open[buf]
  if not s then return end
  local why = STOPS[stop]
  if not why then return end
  note(s, why, stop ~= "cancelled")
  draw(buf)
end

-- A prompt that went wrong (the bridge's word).
function M.failed(buf, why)
  local s = open[buf]
  if not s then return end
  note(s, "✗ " .. vim.trim(tostring(why)), true)
  draw(buf)
end

-- The agent's process ended. One cleared is followed by its next.
function M.exited(buf, code)
  local s = open[buf]
  if not s then return end
  if s.clearing then
    s.clearing = nil
    return
  end
  s.alive = false
  vim.b[buf].corkboard_acp_alive = false
  if code ~= nil and code ~= vim.NIL and code ~= 0 then note(s, ("✗ %s exited with status %d"):format(s.kind.exe, code), true) end
  s.c.ended = "— ended"
  draw(buf)
  require("corkboard.away").report()
  if s.opts.on_exit then s.opts.on_exit(code ~= vim.NIL and code or 0) end
end

return M
