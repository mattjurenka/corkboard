-- Pickers come from snacks.nvim. This sets it up for corkboard: no backdrop
-- (a full-screen float would cut the board panel away), and files picked
-- while the board is the target window open in a split to its right
-- instead of replacing the board.

local M = {}

local function view_win(win)
  return win and vim.api.nvim_win_is_valid(win) and require("corkboard").is_panel(vim.api.nvim_win_get_buf(win))
end

local function confirm(picker, item, action)
  local cmd = action and action.cmd
  if not view_win(picker.main) or (cmd and cmd ~= "vsplit") then
    return Snacks.picker.actions.jump(picker, item, action)
  end
  local main, items = picker.main, picker:selected({ fallback = true })
  vim.cmd.stopinsert()
  picker:close()
  vim.schedule(function()
    vim.api.nvim_set_current_win(main)
    for _, it in ipairs(items) do
      vim.cmd("rightbelow vsplit " .. vim.fn.fnameescape(Snacks.picker.util.path(it)))
      if it.pos then pcall(vim.api.nvim_win_set_cursor, 0, it.pos) end
    end
  end)
end

-- Files open in the window the picker was opened from, so a file picked
-- from the board opens beside it rather than in some other window. Not
-- from a terminal, which a file would replace: from there snacks chooses.
function M.files()
  Snacks.picker.files({ main = { current = vim.bo.buftype ~= "terminal" } })
end

-- A shell in a tab of its own (the tool picker's Terminal).
function M.terminal_tab()
  vim.cmd.tabnew()
  local empty = vim.api.nvim_get_current_buf()
  vim.cmd.terminal()
  -- As with Claude Code below: :terminal leaves tabnew's empty buffer loaded.
  if empty ~= vim.api.nvim_get_current_buf() then pcall(vim.api.nvim_buf_delete, empty, {}) end
  vim.t.corkboard_terminal_tab = true
end

-- Whether a terminal's shell is still running.
local function terminal_alive(buf)
  return buf ~= nil and vim.api.nvim_buf_is_valid(buf) and vim.fn.jobwait({ vim.bo[buf].channel }, 0)[1] == -1
end

-- <C-`>: a shell along the bottom of the tab, under the board or the editor
-- alike. A toggle: hidden when it shows, back (the same shell, still
-- running) when it does not. One per tab; a new one once its shell has
-- exited. Not in a terminal tab, which is a shell already.
function M.terminal()
  if vim.t.corkboard_terminal_tab then return end
  local buf = vim.t.corkboard_terminal
  local valid = buf and vim.api.nvim_buf_is_valid(buf)
  local alive = terminal_alive(buf)
  for _, win in ipairs(valid and vim.api.nvim_tabpage_list_wins(0) or {}) do
    if vim.api.nvim_win_get_buf(win) == buf then
      -- The last window of a tab cannot be hidden.
      if #vim.api.nvim_tabpage_list_wins(0) == 1 then return end
      vim.api.nvim_win_hide(win)
      -- An exited shell's "[Process exited]" is not worth keeping.
      if not alive then pcall(vim.api.nvim_buf_delete, buf, { force = true }) end
      return
    end
  end
  if alive then
    vim.cmd("botright 15split")
    vim.api.nvim_win_set_buf(0, buf)
  else
    vim.cmd("botright 15split | terminal")
    vim.bo.bufhidden = "hide"
    vim.t.corkboard_terminal = vim.api.nvim_get_current_buf()
  end
end

-- Settings for the sessions claude() starts, on top of the user's own: a
-- hook that passes each PushNotification, sent or held back, to the page's
-- notification list (hooks/claude-notification.lua).
-- And one for the session's own events, which keeps its live state
-- (hooks/claude-session.lua).
local function claude_settings()
  local function command(name)
    local hook = vim.api.nvim_get_runtime_file("hooks/" .. name, false)[1]
    return { type = "command", command = table.concat({ vim.fn.shellescape(vim.v.progpath), "--clean --headless -l", vim.fn.shellescape(hook) }, " ") }
  end
  local session = { { hooks = { command("claude-session.lua") } } }
  return {
    hooks = {
      PostToolUse = {
        { matcher = "PushNotification", hooks = { command("claude-notification.lua") } },
        session[1],
      },
      SessionStart = session,
      UserPromptSubmit = session,
      PreToolUse = session,
      PermissionRequest = session,
      Notification = session,
      Stop = session,
    },
  }
end

-- Claude Code holds a PushNotification back when it thinks you are at the
-- terminal, which inside this page it can't tell; the hook passes every one
-- on, and the page raises it when its window isn't focused. So sessions are
-- asked to send them freely rather than sparingly.
local notify_prompt = table.concat({
  "You are running inside corkboard, which forwards PushNotification calls to the user's desktop when they are not looking at it.",
  "Call PushNotification whenever you need the user to decide, approve or do something, and when you finish a task that took more than a minute or two.",
  "Send it even if you think the user is watching; a \"not sent\" result is expected and still reaches them.",
}, " ")

-- Claude Code in a tab of its own, and the tab's terminal buffer, or nil
-- if claude is not on PATH. opts: args (after corkboard's own), cwd (the
-- project's when unset), env (on top of CORKBOARD_BUF), on_exit(status).
function M.start_claude(opts)
  opts = opts or {}
  if vim.fn.executable("claude") == 0 then
    vim.notify("corkboard: claude is not on PATH", vim.log.levels.ERROR)
    return nil
  end
  -- jobstart's terminal takes over tabnew's empty buffer. CORKBOARD_BUF
  -- tells the hooks which terminal the session is in.
  vim.cmd.tabnew()
  local buf = vim.api.nvim_get_current_buf()
  vim.fn.jobstart(vim.list_extend({ "claude", "--settings", vim.json.encode(claude_settings()), "--append-system-prompt", notify_prompt }, opts.args or {}), {
    term = true,
    cwd = opts.cwd,
    env = vim.tbl_extend("force", opts.env or {}, { CORKBOARD_BUF = tostring(buf) }),
  })
  -- When Claude Code exits its tab goes too (deleting the buffer closes
  -- the windows showing it), unless the tab has a terminal still running,
  -- shown or hidden, which would go with it. A failure is reported,
  -- since its output goes with the buffer.
  local tab = vim.api.nvim_get_current_tabpage()
  vim.api.nvim_create_autocmd("TermClose", {
    buffer = vim.api.nvim_get_current_buf(),
    once = true,
    callback = function(args)
      local status = vim.v.event.status
      vim.schedule(function()
        if opts.on_exit then opts.on_exit(status) end
        if vim.api.nvim_tabpage_is_valid(tab) and terminal_alive(vim.t[tab].corkboard_terminal) then return end
        if status ~= 0 then
          vim.notify("corkboard: claude exited with status " .. status, vim.log.levels.WARN)
        end
        pcall(vim.api.nvim_buf_delete, args.buf, { force = true })
      end)
    end,
  })
  return buf
end

-- <C-.>: Claude Code in a tab of its own, in the project's cwd.
function M.claude() M.start_claude() end

-- Go to a terminal: the window showing it, in whichever tab, or a new tab
-- for it if it is hidden. False when the buffer is gone.
function M.focus_terminal(buf)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return false end
  local win = vim.fn.win_findbuf(buf)[1]
  if win then
    vim.api.nvim_set_current_win(win)
  else
    vim.cmd.tabnew()
    local empty = vim.api.nvim_get_current_buf()
    vim.api.nvim_win_set_buf(0, buf)
    pcall(vim.api.nvim_buf_delete, empty, {})
  end
  return true
end

-- The tool picker (<C-Space>): things to open, run in the window the picker
-- was opened from.
local tools = {
  {
    text = "New buffer",
    hint = "",
    run = function(main)
      vim.cmd(view_win(main) and "rightbelow vnew" or "enew")
    end,
  },
  {
    text = "Open file",
    hint = "<C-f>",
    run = M.files,
  },
  {
    text = "Open project",
    hint = "",
    run = function()
      Snacks.picker.projects({
        -- Repos sit directly under home here, not in ~/dev or ~/projects.
        -- A machine that keeps them elsewhere sets g:corkboard_project_dirs.
        dev = vim.g.corkboard_project_dirs or { "~" },
        -- corkboard's own record of what was opened; see recent_projects.
        projects = require("corkboard").recent_projects(),
        -- With no project open yet (the cwd is home, where corkboard starts
        -- without one) this window becomes the project: a global :cd rather
        -- than snacks' tab-local one, so the board (which is the cwd's) and
        -- every tab follow it. With one open, the project gets
        -- a window of its own, which the browser opens.
        confirm = function(picker, item)
          picker:close()
          if not item then return end
          if vim.fn.getcwd() ~= vim.uv.os_homedir() then
            require("corkboard").notify("corkboard.open", { cwd = item.file })
            return
          end
          vim.cmd.cd(vim.fn.fnameescape(item.file))
          vim.notify("Project: " .. vim.fn.fnamemodify(item.file, ":~"))
        end,
      })
    end,
  },
  {
    text = "Card from this line",
    hint = "<leader>c",
    run = function()
      local lnum = vim.api.nvim_win_get_cursor(0)[1]
      require("corkboard.board").card_from_code(lnum, lnum)
    end,
  },
  {
    text = "Token usage",
    hint = "<leader>u",
    run = function() require("corkboard.usage").show() end,
  },
  {
    text = "Claude Code",
    hint = "<C-.>",
    run = M.claude,
  },
  {
    text = "Terminal",
    hint = "",
    run = M.terminal_tab,
  },
}

function M.tools()
  -- Not picker.main: snacks passes over the board's scratch buffer when it
  -- picks a main window, so with a terminal open it would choose the terminal.
  local main = vim.api.nvim_get_current_win()
  Snacks.picker.pick({
    source = "corkboard_tools",
    -- Copies: snacks keeps match state on the items, and items left over
    -- from the last picker match nothing in the next one.
    items = vim.tbl_map(function(t) return vim.deepcopy(t) end, tools),
    format = function(item)
      return { { item.text }, { item.hint ~= "" and "  " .. item.hint or "", "Comment" } }
    end,
    layout = { preset = "select" },
    confirm = function(picker, item)
      picker:close()
      if not item then return end
      vim.schedule(function()
        if vim.api.nvim_win_is_valid(main) then vim.api.nvim_set_current_win(main) end
        item.run(main)
      end)
    end,
  })
end

function M.setup()
  local ok, snacks = pcall(require, "snacks")
  if not ok then return false end
  snacks.setup({
    picker = {
      enabled = true,
      layout = { layout = { backdrop = false } },
      actions = { confirm = confirm },
    },
  })
  return true
end

return M
