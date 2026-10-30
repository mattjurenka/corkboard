-- Claude Code's hook for a session's own events, set by corkboard.claude.
-- Runs as `nvim -l` and hands each event to the Neovim whose terminal the
-- session is in ($NVIM, $CORKBOARD_BUF), where corkboard.agents keeps the
-- session's live state. Fails silently: a hook's error would only show up in
-- the session, and PreToolUse waits for it.

local addr = os.getenv("NVIM")
local buf = tonumber(os.getenv("CORKBOARD_BUF") or "")
if not (addr and buf) then return end
local ok, input = pcall(vim.json.decode, io.read("a"))
if not ok or type(input) ~= "table" then return end

-- The card a corkboard MCP tool took or let go of: the first id in its
-- result, which is the card's JSON when it worked (an error is plain text).
local tool = type(input.tool_name) == "string" and input.tool_name:match("^mcp__corkboard__(.+)$")
local card
if input.hook_event_name == "PostToolUse" and (tool == "claim_card" or tool == "release_card" or tool == "next_card") then
  local text = vim.F.npcall(vim.json.encode, input.tool_response) or ""
  card = text:match('\\*"id\\*"%s*:%s*\\*"(%a+%-%d+)')
  card = card and card:upper()
end

-- Work a tool left running after it returned (a command run in the
-- background, a Monitor, a background agent): the session isn't done with
-- the turn's work until its task-notification comes back. And a /loop's
-- next wakeup.
local background, wakeup
if input.hook_event_name == "PostToolUse" then
  local args = type(input.tool_input) == "table" and input.tool_input or {}
  local text = vim.F.npcall(vim.json.encode, input.tool_response) or ""
  background = args.run_in_background == true or input.tool_name == "Monitor" or input.tool_name == "Workflow"
    or text:find("async_launched", 1, true) ~= nil or text:find("running in background", 1, true) ~= nil
  wakeup = input.tool_name == "ScheduleWakeup" and args.stop ~= true
end

local chan = vim.F.npcall(vim.fn.sockconnect, "pipe", addr, { rpc = true })
if not chan or chan == 0 then return end
-- A notification, not a request: the session needn't wait on Neovim.
pcall(vim.rpcnotify, chan, "nvim_exec_lua", "require('corkboard.agents').hook(...)", {
  {
    buf = buf,
    event = input.hook_event_name,
    session_id = input.session_id,
    transcript_path = input.transcript_path,
    notification_type = input.notification_type,
    message = input.message,
    tool_name = input.tool_name,
    tool_use_id = input.tool_use_id,
    background = background or nil,
    wakeup = wakeup or nil,
    corkboard_tool = tool or nil,
    card = card,
    -- AskUserQuestion's first question, for the card's attention.
    question = type(input.tool_input) == "table" and type(input.tool_input.questions) == "table"
      and type(input.tool_input.questions[1]) == "table" and input.tool_input.questions[1].question or nil,
  },
})
-- rpcnotify only queues; this makes sure it went before the process ends.
pcall(vim.rpcrequest, chan, "nvim_get_mode")
