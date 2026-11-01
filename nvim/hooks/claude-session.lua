-- Claude Code's hook for a session's own events, set by corkboard.claude.
-- Runs as `nvim -l` and hands each event to the Neovim whose terminal the
-- session is in ($NVIM, $CORKBOARD_BUF), where corkboard.agents keeps the
-- session's live state. Fails silently: a hook's error would only show up in
-- the session, and PreToolUse waits for it.
--
-- It also keeps the session's context under its limit (corkboard.context):
-- past NUDGE of it, each tool's result comes with a word to hand off; past
-- STOP of it, the only tools it may use are the ones that do. Only where
-- something starts the next session from the handoff: a corkboard Neovim,
-- or a fleet slot's task ($CORKBOARD_HANDOFF).

local ok, input = pcall(vim.json.decode, io.read("a"))
if not ok or type(input) ~= "table" then return end

local here = vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))
local context = vim.F.npcall(dofile, vim.fs.joinpath(here, "..", "lua", "corkboard", "context.lua"))
local restarts = (os.getenv("NVIM") and os.getenv("CORKBOARD_BUF")) or os.getenv("CORKBOARD_HANDOFF")
-- A subagent's tools are its own context's, not the session's.
local used = restarts and context and not input.agent_id and context.last(input.transcript_path)
-- A session that looked for the handoff tool and found none (no corkboard
-- MCP) is left alone, rather than held at STOP with no way out.
local missing = vim.fs.joinpath(vim.fn.stdpath("state"), "corkboard", "no-handoff", tostring(input.session_id))
if used and input.hook_event_name == "PostToolUse" and input.tool_name == "ToolSearch"
  and type(input.tool_input) == "table" and tostring(input.tool_input.query or ""):find("handoff", 1, true)
  and not (vim.F.npcall(vim.json.encode, input.tool_response) or ""):find("mcp__corkboard__handoff", 1, true) then
  vim.fn.mkdir(vim.fs.dirname(missing), "p")
  pcall(vim.fn.writefile, {}, missing)
end
if used and vim.uv.fs_stat(missing) then used = nil end
if used then
  local limit = context.limit()
  local k = math.floor(used / 1000 + 0.5)
  local ASK = "call the corkboard MCP's handoff tool (load it with ToolSearch if it isn't loaded) with what the next session needs:"
    .. " the goal, what's done and verified, what's left, and anything you learned that it would otherwise have to find again."
    .. " Then end your turn: corkboard clears this session and starts the next one from your handoff."
  local HANDOFF_TOOLS = { ToolSearch = true, mcp__corkboard__handoff = true }
  local out
  if input.hook_event_name == "PreToolUse" and used >= limit * context.STOP and not HANDOFF_TOOLS[input.tool_name] then
    out = {
      hookSpecificOutput = {
        hookEventName = "PreToolUse",
        permissionDecision = "deny",
        permissionDecisionReason = string.format("This session's context is %dk, too near its %dk limit to do more. Now %s", k, math.floor(limit / 1000), ASK),
      },
    }
  elseif (input.hook_event_name == "PostToolUse" or input.hook_event_name == "UserPromptSubmit") and used >= limit * context.NUDGE
    and input.tool_name ~= "mcp__corkboard__handoff" then
    out = {
      hookSpecificOutput = {
        hookEventName = input.hook_event_name,
        additionalContext = string.format("This session's context is %dk of its %dk limit. Finish the step you're on, then %s", k, math.floor(limit / 1000), ASK),
      },
    }
  end
  if out then io.write(vim.json.encode(out)) end
end

local tool = type(input.tool_name) == "string" and input.tool_name:match("^mcp__corkboard__(.+)$")
-- What it handed off with, which the session after it starts from. Where
-- no Neovim restarts it (a fleet slot), it goes in $CORKBOARD_HANDOFF.
local handoff = input.hook_event_name == "PostToolUse" and tool == "handoff" and type(input.tool_input) == "table"
  and type(input.tool_input.text) == "string" and input.tool_input.text or nil
if handoff and os.getenv("CORKBOARD_HANDOFF") then
  pcall(vim.fn.writefile, vim.split(handoff, "\n", { plain = true }), os.getenv("CORKBOARD_HANDOFF"))
end

local addr = os.getenv("NVIM")
local buf = tonumber(os.getenv("CORKBOARD_BUF") or "")
if not (addr and buf) then return end

-- The card a corkboard MCP tool took or let go of: the first id in its
-- result, which is the card's JSON when it worked (an error is plain text).
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
  -- The result's own fields, not its text, which may be anything (a file
  -- that mentions them, as this one does).
  local result = type(input.tool_response) == "table" and input.tool_response or {}
  background = args.run_in_background == true or input.tool_name == "Monitor" or input.tool_name == "Workflow"
    or result.status == "async_launched" or result.backgroundTaskId ~= nil
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
    handoff = handoff,
    -- AskUserQuestion's first question, for the card's attention.
    question = type(input.tool_input) == "table" and type(input.tool_input.questions) == "table"
      and type(input.tool_input.questions[1]) == "table" and input.tool_input.questions[1].question or nil,
  },
})
-- rpcnotify only queues; this makes sure it went before the process ends.
pcall(vim.rpcrequest, chan, "nvim_get_mode")
