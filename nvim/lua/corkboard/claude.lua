-- Claude Code sessions in tabs of their own, wired back to corkboard through
-- hooks (nvim/hooks/): their PushNotifications reach the page's list, and
-- their events keep corkboard.agents' idea of what each session is doing.

local M = {}

local function hook(name)
  local script = vim.api.nvim_get_runtime_file("hooks/" .. name, false)[1]
  return {
    type = "command",
    command = table.concat({ vim.fn.shellescape(vim.v.progpath), "--clean --headless -l", vim.fn.shellescape(script) }, " "),
  }
end

-- Added to the user's own settings.
local function settings()
  local session = { hooks = { hook("claude-session.lua") } }
  return {
    hooks = {
      PostToolUse = {
        { matcher = "PushNotification", hooks = { hook("claude-notification.lua") } },
        session,
      },
      SessionStart = { session },
      UserPromptSubmit = { session },
      PreToolUse = { session },
      PermissionRequest = { session },
      Notification = { session },
      Stop = { session },
    },
  }
end

-- Claude Code can't tell whether you are looking at a terminal inside this
-- page, so the notification hook passes every PushNotification on and the
-- page decides. Sessions are asked to send them freely.
local NOTIFY_PROMPT = table.concat({
  "You are running inside corkboard, which forwards PushNotification calls to the user's desktop when they are not looking at it.",
  "Call PushNotification whenever you need the user to decide, approve or do something, and when you finish a task that took more than a minute or two.",
  "Send it even if you think the user is watching; a \"not sent\" result is expected and still reaches them.",
}, " ")

-- Start Claude Code in a new tab; returns its terminal buffer, or nil when
-- claude is not on PATH. opts: args (after corkboard's own), cwd, env,
-- on_exit(status), prompt (added to the system prompt after corkboard's),
-- split (in a window to the right of the current one instead of a tab). The
-- tab closes with the session, unless a shell in it is still running.
function M.start(opts)
  opts = opts or {}
  if vim.fn.executable("claude") == 0 then
    vim.notify("corkboard: claude is not on PATH", vim.log.levels.ERROR)
    return nil
  end
  if opts.split then
    vim.cmd("rightbelow vnew")
  else
    vim.cmd.tabnew()
  end
  local buf = vim.api.nvim_get_current_buf()
  local tab = vim.api.nvim_get_current_tabpage()
  local prompt = opts.prompt and (NOTIFY_PROMPT .. "\n\n" .. opts.prompt) or NOTIFY_PROMPT
  local cmd = { "claude", "--settings", vim.json.encode(settings()), "--append-system-prompt", prompt }
  vim.fn.jobstart(vim.list_extend(cmd, opts.args or {}), {
    term = true,
    cwd = opts.cwd,
    -- CORKBOARD_BUF tells the hooks which terminal the session is in.
    env = vim.tbl_extend("force", opts.env or {}, { CORKBOARD_BUF = tostring(buf) }),
  })
  vim.api.nvim_create_autocmd("TermClose", {
    buffer = buf,
    once = true,
    callback = function()
      local status = vim.v.event.status
      vim.schedule(function()
        if opts.on_exit then opts.on_exit(status) end
        if vim.api.nvim_tabpage_is_valid(tab) and require("corkboard.terminal").alive(vim.t[tab].corkboard_terminal) then return end
        -- The buffer and its output go with the tab, so say why.
        if status ~= 0 then vim.notify("corkboard: claude exited with status " .. status, vim.log.levels.WARN) end
        pcall(vim.api.nvim_buf_delete, buf, { force = true })
      end)
    end,
  })
  return buf
end

-- <C-.>: Claude Code in the project.
function M.open() M.start() end

return M
