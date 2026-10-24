-- Claude Code's hooks for a session's own events (SessionStart,
-- UserPromptSubmit, Pre/PostToolUse, PermissionRequest, Notification,
-- Stop), which
-- corkboard.picker's start_claude() gives the sessions it starts. It runs as
-- `nvim -l` and hands each event to the Neovim whose terminal the session
-- is in ($NVIM, $CORKBOARD_BUF), where corkboard.agents keeps the session's
-- live state. Anything amiss and it does nothing: a hook's failure would
-- only show up in the session, and PreToolUse waits for it.

local addr = os.getenv("NVIM")
local buf = tonumber(os.getenv("CORKBOARD_BUF") or "")
if not (addr and buf) then return end
local ok, input = pcall(vim.json.decode, io.read("a"))
if not ok or type(input) ~= "table" then return end

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
    -- AskUserQuestion's first question, for the card's attention.
    question = type(input.tool_input) == "table" and type(input.tool_input.questions) == "table"
      and type(input.tool_input.questions[1]) == "table" and input.tool_input.questions[1].question or nil,
  },
})
-- rpcnotify only queues; this makes sure it went before the process ends.
pcall(vim.rpcrequest, chan, "nvim_get_mode")
