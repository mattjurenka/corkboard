-- Claude Code's PostToolUse hook for PushNotification, set by
-- corkboard.claude. Runs as `nvim -l` and hands each notification, sent or
-- not, to the Neovim whose terminal the session is in ($NVIM), which passes
-- it to the page (corkboard.notification). Fails silently: a hook's error
-- would only show up in the session.

local addr = os.getenv("NVIM")
if not addr then return end
local ok, input = pcall(vim.json.decode, io.read("a"))
if not ok or type(input) ~= "table" or type(input.tool_input) ~= "table" then return end

-- The tool's result says when it held the notification back ("Not sent —
-- this terminal is active…"); it arrives as text or wrapped in a table.
local response = input.tool_response
if type(response) ~= "string" then response = vim.json.encode(response or "") end
local held = response:match("[Nn]ot sent%s*[—%-:]+%s*([^\"]*)")

local chan = vim.F.npcall(vim.fn.sockconnect, "pipe", addr, { rpc = true })
if not chan or chan == 0 then return end
pcall(vim.rpcrequest, chan, "nvim_exec_lua", "require('corkboard').notify('corkboard.notification', ...)", {
  {
    source = "claude",
    message = input.tool_input.message,
    cwd = input.cwd,
    sent = held == nil,
    reason = held,
    -- The session's terminal, set by corkboard.claude.
    buf = tonumber(os.getenv("CORKBOARD_BUF") or ""),
  },
})
