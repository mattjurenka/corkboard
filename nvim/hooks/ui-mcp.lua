-- corkboard-ui as an MCP server of its own, on stdio, for a kind that
-- doesn't load the mod (claude-plugin/, Claude Code's alone): ask and
-- notify in place of AskUserQuestion and PushNotification, and the mod's
-- show, say and emote (.agent/plans/agents.md, stage 4). Runs as
-- `nvim --clean --headless -l ui-mcp.lua` with $NVIM and $CORKBOARD_BUF, as
-- the hooks do (corkboard.agent's ui_server), and does each call in that
-- Neovim.
--
-- ask waits for the answers $CORKBOARD_ASK_WAIT seconds (50: under the
-- shortest MCP call timeout of the CLIs, Codex's minute); then it says so,
-- and the answers come as the session's next prompt (corkboard.questions).

local buf = tonumber(os.getenv("CORKBOARD_BUF") or "")
local addr = os.getenv("NVIM")
local WAIT = tonumber(os.getenv("CORKBOARD_ASK_WAIT") or "") or 50

local chan
local function nvim(code, ...)
  if not chan then
    chan = addr and vim.F.npcall(vim.fn.sockconnect, "pipe", addr, { rpc = true }) or nil
    if chan == 0 then chan = nil end
  end
  if not chan then error("corkboard's Neovim isn't there", 0) end
  local ok, got = pcall(vim.rpcrequest, chan, "nvim_exec_lua", code, { ... })
  if not ok then
    chan = nil
    error(tostring(got), 0)
  end
  return got
end

local str = function(d) return { type = "string", description = d } end

local QUESTION = {
  type = "object",
  properties = {
    question = str("The whole question, ending in a question mark"),
    header = str("A label of a few words for it"),
    multiSelect = { type = "boolean", description = "Whether more than one option can be picked" },
    options = {
      type = "array",
      description = "2 to 4 choices; the user can always answer in their own words instead",
      items = { type = "object", properties = { label = str("The choice, a few words"), description = str("What it means") }, required = { "label" } },
    },
  },
  required = { "question" },
}

local MOODS = { "happy", "excited", "teasing", "annoyed", "sulky", "shy", "sad", "surprised" }

local TOOLS = {
  ask = {
    description = "Ask the user a question you can't settle yourself, with choices. Their card and phone show it, and the answers come back as this call's result, or, if they take longer, as your next prompt.",
    properties = { questions = { type = "array", description = "1 to 4 questions", items = QUESTION } },
    required = { "questions" },
  },
  notify = {
    description = "Tell the user on their desktop: when you need them to decide, approve or do something, and when you finish a task that took more than a minute or two. Under 200 characters, one line, no markdown.",
    properties = { message = str("What they'd act on, first") },
    required = { "message" },
  },
  show = {
    description = "Show the user a file in the media panel beside this session: a screenshot, image, plot, video, audio, PDF or text file.",
    properties = { path = str("The file's path, absolute or relative to the session's directory"), title = str("What to call it in the panel's list") },
    required = { "path" },
  },
  say = {
    description = "Say something out loud through the avatar panel beside this session, when it's open. Plain talk in short sentences, no markdown, code, paths or URLs.",
    properties = { text = str("What to say, a few sentences"), mood = { type = "string", enum = MOODS, description = "How it is said" } },
    required = { "text" },
  },
  emote = {
    description = "Have the avatar beside this session do something, now and then, when it fits.",
    properties = { emote = { type = "string", enum = { "wave", "thumbs", "nod", "bow", "shrug", "jump" } } },
    required = { "emote" },
  },
}
local ORDER = { "ask", "notify", "show", "say", "emote" }

local CALLS = {}

-- A function's two results (ok or a value, then why), as fields: a nil in a
-- list crosses msgpack as vim.NIL, which is true.
local function two(call)
  return ("local a, b = %s(...); return { a = a or false, b = b or false }"):format(call)
end

function CALLS.ask(a)
  local got = nvim(two("require('corkboard.questions').open"), buf, a.questions)
  if not got.a then error(got.b, 0) end
  local id = got.a
  local deadline = vim.uv.now() + WAIT * 1000
  while vim.uv.now() < deadline do
    local words = nvim("return require('corkboard.questions').result(...)", id)
    if words ~= vim.NIL and words ~= nil then return words end
    vim.uv.sleep(300)
    vim.uv.update_time()
  end
  nvim("require('corkboard.questions').wait_over(...)", id)
  return "The user hasn't answered yet. Carry on with what doesn't depend on it; their answers will come as your next prompt."
end

function CALLS.notify(a)
  -- Its source is the session's kind, as "claude" is Claude Code's, and the
  -- page titles it with the kind's label.
  nvim([[
    local n = ...
    local kind = n.buf and vim.api.nvim_buf_is_valid(n.buf) and require("corkboard.agent").of(n.buf)
    n.source, n.label = kind and kind.name or "agent", kind and kind.label or nil
    require('corkboard').notify('corkboard.notification', n)
  ]], {
    message = a.message,
    cwd = vim.uv.cwd(),
    sent = true,
    buf = buf,
  })
  return "sent"
end

function CALLS.show(a)
  local got = nvim(two("require('corkboard.claude.cards').show_file"), buf or -1, a.path, a.title)
  if not got.a then error(got.b or "not shown", 0) end
  return got.b or "shown"
end

function CALLS.say(a)
  nvim("require('corkboard.avatar').say(...)", buf, { text = a.text, mood = a.mood })
  return "said"
end

function CALLS.emote(a)
  nvim("require('corkboard.avatar').say(...)", buf, { emote = a.emote })
  return "done"
end

local function send(msg)
  io.stdout:write(vim.json.encode(msg), "\n")
  io.stdout:flush()
end

local function tools()
  local out = {}
  for _, name in ipairs(ORDER) do
    local t = TOOLS[name]
    table.insert(out, { name = name, description = t.description, inputSchema = { type = "object", properties = t.properties, required = t.required } })
  end
  return out
end

local function handle(req)
  if req.method == "initialize" then
    local version = type(req.params) == "table" and req.params.protocolVersion or nil
    return { protocolVersion = version or "2025-06-18", capabilities = { tools = vim.empty_dict() }, serverInfo = { name = "corkboard-ui", version = "0.1.0" } }
  elseif req.method == "tools/list" then
    return { tools = tools() }
  elseif req.method == "tools/call" then
    local name = req.params and req.params.name
    local args = req.params and req.params.arguments or {}
    if not CALLS[name] then return { content = { { type = "text", text = "no tool called " .. tostring(name) } }, isError = true } end
    local ok, text = pcall(CALLS[name], type(args) == "table" and args or {})
    return { content = { { type = "text", text = tostring(text) } }, isError = not ok or nil }
  elseif req.method == "ping" then
    return vim.empty_dict()
  end
  return nil, { code = -32601, message = "no method " .. tostring(req.method) }
end

for line in io.stdin:lines() do
  local ok, req = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
  if ok and type(req) == "table" and req.id ~= nil then
    local result, err = handle(req)
    send(err and { jsonrpc = "2.0", id = req.id, error = err } or { jsonrpc = "2.0", id = req.id, result = result })
  end
end
