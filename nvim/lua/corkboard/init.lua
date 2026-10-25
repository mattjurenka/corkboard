-- The Neovim half of corkboard. The browser attaches its RPC channel here,
-- and everything the HTML panels show is pushed from this side with
-- rpcnotify, so state and keymaps live in Neovim.
--
-- An HTML panel is a real Neovim window: a scratch buffer with
-- b:corkboard_view set. The browser draws the panel over that window's
-- rectangle, so splits, tabs and <C-w> all apply to it.

local M = {}

-- Which window this Neovim is: nil for a project's, "plan" for the day
-- plan's, which the bridge starts with CORKBOARD_WINDOW=plan (?view=plan).
M.window = vim.env.CORKBOARD_WINDOW

-- The Claude account the day plan's Claude Code is logged in to
-- (corkboard.plan.claude). CORKBOARD_PLAN_ACCOUNT overrides it.
M.plan_account = vim.env.CORKBOARD_PLAN_ACCOUNT or "matthewjurenka@gmail.com"

local chans = {}
-- What each channel was last sent, so unchanged state isn't sent again.
-- shown_preview: the preview tab last sent (M.push_preview); false when
-- the page has been sent nothing.
local last_layout, last_scroll, last_context
local shown_preview = false

-- The last project opened, which the bridge opens when a page names no
-- ?cwd. Shared with bridge/server.ts, so not under stdpath().
local last_project_file = vim.fs.joinpath(
  vim.env.XDG_STATE_HOME or vim.fs.joinpath(vim.uv.os_homedir(), ".local/state"),
  "corkboard",
  "last-project"
)

-- Every project opened, newest first, for Open project. Not snacks' recent
-- list: that comes from oldfiles, and the bridge stops Neovim with SIGTERM,
-- so shada is never written.
local projects_file = vim.fs.joinpath(vim.fs.dirname(last_project_file), "projects")
local max_projects = 50

function M.recent_projects()
  local ok, lines = pcall(vim.fn.readfile, projects_file)
  if not ok then return {} end
  return vim.tbl_filter(function(dir) return vim.fn.isdirectory(dir) == 1 end, lines)
end

-- Home is where corkboard lands without a project, so it is not one.
local function remember_project()
  local cwd = vim.fn.getcwd(-1, -1)
  if cwd == vim.uv.os_homedir() then return end
  vim.fn.mkdir(vim.fs.dirname(last_project_file), "p")
  pcall(vim.fn.writefile, { cwd }, last_project_file)
  local projects = { cwd }
  for _, dir in ipairs(M.recent_projects()) do
    if dir ~= cwd and #projects < max_projects then table.insert(projects, dir) end
  end
  pcall(vim.fn.writefile, projects, projects_file)
end

-- The statusline's dimmed folder, in Comment's colour. Foreground only, so it
-- suits whichever bar it is in (a terminal's is StatusLineTerm). Set again
-- after every colorscheme, which clears it.
local function status_highlights()
  local dim = vim.api.nvim_get_hl(0, { name = "Comment", link = false })
  vim.api.nvim_set_hl(0, "CorkboardStatusDetail", { fg = dim.fg })
end

-- Called by the browser with its own channel id after nvim_ui_attach.
function M.attach(chan)
  chans[chan] = true
  -- By now every plugin has loaded, including a colorscheme that set its
  -- highlights without a ColorScheme event (stylix's).
  status_highlights()
  M.push_theme()
  -- The new channel has seen nothing yet.
  last_context, last_layout, last_scroll, shown_preview = nil, nil, nil, false
  vim.schedule(M.push_preview)
  M.push_context()
  require("corkboard.board").push_all()
  require("corkboard.viewer").push_all()
  require("corkboard.usage").push_all()
  require("corkboard.plan").push_all()
  M.push_layout()
end

-- Whether a page is attached.
function M.attached() return next(chans) ~= nil end

function M.notify(method, ...)
  for chan in pairs(chans) do
    if not pcall(vim.rpcnotify, chan, method, ...) then chans[chan] = nil end
  end
end

-- The window's rectangle in grid cells, border included.
local function rect(win, config)
  local pos = vim.api.nvim_win_get_position(win)
  local r = {
    row = pos[1],
    col = pos[2],
    width = vim.api.nvim_win_get_width(win),
    height = vim.api.nvim_win_get_height(win),
  }
  -- Floats report the border's corner as their position and exclude the
  -- border from width/height. Border sides: 2 top, 4 right, 6 bottom, 8 left.
  local b = config.border
  if type(b) == "table" and #b == 8 then
    local function has(i) return b[i] ~= "" and 1 or 0 end
    r.width = r.width + has(4) + has(8)
    r.height = r.height + has(2) + has(6)
  end
  return r
end

-- Windows in the current tabpage that show an HTML view, the floats the
-- browser must not cover, and the focused window (with its status line),
-- which the browser outlines when the tab is split. In grid cells.
function M.layout()
  local views, floats, current = {}, {}, vim.api.nvim_get_current_win()
  local splits, focus = 0, nil
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local config = vim.api.nvim_win_get_config(win)
    local buf = vim.api.nvim_win_get_buf(win)
    local view = vim.b[buf].corkboard_view
    local floating = config.relative ~= ""
    if not floating then
      splits = splits + 1
      if win == current then focus = rect(win, config) end
    end
    if view then
      table.insert(views, vim.tbl_extend("error", rect(win, config), {
        win = win,
        buf = buf,
        view = view,
        focused = win == current,
        float = floating,
      }))
    elseif floating and not config.hide then
      table.insert(floats, rect(win, config))
    end
  end
  if focus then
    if splits < 2 then
      focus = nil
    elseif vim.o.laststatus == 1 or vim.o.laststatus == 2 then
      focus.height = focus.height + 1 -- its own status line
    end
  end
  return { views = views, floats = floats, focus = focus }
end

-- Checked after every redraw and sent when it changed. Window events aren't
-- enough: plugins move floats with nvim_win_set_config, which fires no
-- autocommand, but every visible change redraws.
--
-- Synchronous, not scheduled: on_end runs before the grid is flushed to the
-- UI, so the browser places a panel before painting the text beneath it.
-- Scheduled, the view buffer's text flashed for a frame on tab switches.
function M.push_layout()
  local layout = M.layout()
  local key = vim.json.encode(layout)
  if key ~= last_layout then
    last_layout = key
    M.notify("corkboard.layout", layout)
  end
  -- Separate from the layout, which redraws every panel: scrolling changes
  -- this on nearly every redraw.
  local scroll = { bars = M.scrollbars(), floats = layout.floats }
  key = vim.json.encode(scroll)
  if key ~= last_scroll then
    last_scroll = key
    M.notify("corkboard.scroll", scroll)
  end
end

-- For the browser's scrollbars: each split in the tab showing text, as its
-- rectangle in grid cells (status line excluded), the first and last lines
-- on screen, and the buffer's length. Not terminals or panels.
function M.scrollbars()
  local bars = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local buf = vim.api.nvim_win_get_buf(win)
    if vim.api.nvim_win_get_config(win).relative == "" and not vim.b[buf].corkboard_view
      and vim.bo[buf].buftype ~= "terminal" then
      local info = vim.fn.getwininfo(win)[1]
      table.insert(bars, {
        win = win,
        row = info.winrow - 1,
        col = info.wincol - 1,
        width = info.width,
        height = info.height,
        top = info.topline,
        bottom = info.botline,
        lines = vim.api.nvim_buf_line_count(buf),
      })
    end
  end
  return bars
end

-- A scrollbar dragged or clicked: top as the window's first line. The
-- cursor moves only as far as it must to stay on screen, or Neovim would
-- scroll straight back to it.
function M.scroll_to(win, top)
  if not vim.api.nvim_win_is_valid(win) then return end
  vim.api.nvim_win_call(win, function()
    local height, count = vim.api.nvim_win_get_height(0), vim.api.nvim_buf_line_count(0)
    top = math.max(1, math.min(math.floor(top), count - height + 1))
    local so = vim.wo.scrolloff >= 0 and vim.wo.scrolloff or vim.o.scrolloff
    so = math.min(so, math.floor((height - 1) / 2))
    local view = vim.fn.winsaveview()
    if view.topline == top then return end
    local first = top == 1 and 1 or top + so
    local last = top + height - 1 >= count and count or top + height - 1 - so
    view.topline = top
    view.lnum = math.max(first, math.min(view.lnum, last))
    vim.fn.winrestview(view)
  end)
end

-- The panels' accent colours, from highlight groups every colorscheme sets
-- (background and text come with the grid's default colours). Optionally a
-- font: vim.g.corkboard_font = { family = ..., size = ... }.
function M.push_theme()
  local function fg(...)
    for _, group in ipairs({ ... }) do
      local c = vim.api.nvim_get_hl(0, { name = group, link = false }).fg
      if c then return ("#%06x"):format(c) end
    end
  end
  local function bg(group)
    local c = vim.api.nvim_get_hl(0, { name = group, link = false }).bg
    return c and ("#%06x"):format(c) or nil
  end
  M.notify("corkboard.theme", {
    -- The focused window's outline, in the colour of its status line.
    focus = bg("StatusLine"),
    -- The selected card, tab and file, as a visual selection.
    selection = bg("Visual"),
    accent = fg("Function", "Identifier"),
    working = fg("DiagnosticOk", "String"),
    blocked = fg("DiagnosticError", "ErrorMsg"),
    review = fg("DiagnosticWarn", "WarningMsg"),
    -- A fourth color for the day plan's projects; the page's own when the
    -- colorscheme's keywords are plain text color.
    special = (function()
      local c = fg("Keyword", "Statement")
      return c ~= fg("Normal") and c or nil
    end)(),
    font = vim.g.corkboard_font,
  })
end

-- The project (the cwd) and the current window's file, for the sidebar.
function M.push_context()
  local buf = vim.api.nvim_get_current_buf()
  local file = (vim.bo[buf].buftype == "" or vim.b[buf].corkboard_file) and vim.api.nvim_buf_get_name(buf) or ""
  local context = { cwd = vim.fn.getcwd(), file = file ~= "" and file or nil }
  local key = vim.json.encode(context)
  if key == last_context then return end
  last_context = key
  M.notify("corkboard.context", context)
end

-- Each entry of dir that git sees as changed: "added" or "modified". A
-- folder takes the status of what changed inside it, modified over added.
local function git_status(dir)
  local status = {}
  local prefix = vim.system({ "git", "rev-parse", "--show-prefix" }, { cwd = dir }):wait()
  if prefix.code ~= 0 then return status end
  prefix = vim.trim(prefix.stdout)
  -- Porcelain paths are relative to the repository root, whatever the cwd.
  local result = vim.system({ "git", "status", "--porcelain", "-z", "--untracked-files=normal", "--", "." }, { cwd = dir }):wait()
  local fields = vim.split(result.stdout or "", "\0", { plain = true, trimempty = true })
  local i = 1
  while i <= #fields do
    local xy, path = fields[i]:sub(1, 2), fields[i]:sub(4)
    -- A rename or copy carries its old path as the next field.
    if xy:find("[RC]") then i = i + 1 end
    i = i + 1
    local name = path:sub(#prefix + 1):match("^[^/]+")
    if name then
      -- New to git, whether or not it has been staged yet.
      local kind = (xy == "??" or xy:sub(1, 1) == "A") and "added" or "modified"
      if status[name] ~= "modified" then status[name] = kind end
    end
  end
  return status
end

-- One directory for the file browser: folders first, then files, by name,
-- without .git, each marked if git ignores it or it has changed.
function M.list_dir(dir)
  local entries, names = {}, {}
  for name, type in vim.fs.dir(dir) do
    if name ~= ".git" then
      if type == "link" then
        local stat = vim.uv.fs_stat(vim.fs.joinpath(dir, name))
        type = stat and stat.type or "file"
      end
      table.insert(entries, { name = name, dir = type == "directory" })
      table.insert(names, name)
    end
  end
  -- Outside a repository git exits non-zero and prints nothing.
  local ignored = {}
  local result = vim.system({ "git", "check-ignore", "--stdin" }, { cwd = dir, stdin = table.concat(names, "\n") }):wait()
  for name in (result.stdout or ""):gmatch("[^\n]+") do ignored[name] = true end
  local status = git_status(dir)
  for _, e in ipairs(entries) do
    e.ignored = ignored[e.name] or nil
    e.git = status[e.name]
  end
  table.sort(entries, function(a, b)
    if a.dir ~= b.dir then return a.dir end
    return a.name:lower() < b.name:lower()
  end)
  return entries
end

-- An HTML panel such as the board or a markdown preview, as opposed to a
-- file an HTML viewer draws (an image, a PDF; see corkboard.viewer).
function M.is_panel(buf)
  return vim.b[buf].corkboard_view ~= nil and not vim.b[buf].corkboard_file
end

-- <leader>p, :AgentPlan: the day plan, which has a window of its own. Here,
-- that's the plan's tab; in a project's window, the page opens the plan's
-- window, or brings it forward if it's open.
function M.open_plan()
  if M.window == "plan" then return require("corkboard.plan").show() end
  if not M.attached() then return vim.notify("corkboard: the day plan opens from the page") end
  M.notify("corkboard.open_plan")
end

-- The file explorer's preview, as VS Code has one: the tab its last file
-- opened in, while that file is still untouched. The next file opened from
-- the explorer replaces it there instead of adding a tab. An edit (any
-- change to the buffer, saved or not) keeps it: { tab, buf, tick }.
local preview

local function preview_win()
  if not (preview and vim.api.nvim_tabpage_is_valid(preview.tab) and vim.api.nvim_buf_is_valid(preview.buf)) then return end
  if vim.api.nvim_buf_get_changedtick(preview.buf) ~= preview.tick then return end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(preview.tab)) do
    if vim.api.nvim_win_get_buf(win) == preview.buf then return win end
  end
end

function M.preview_tab()
  return preview_win() and preview.tab or nil
end

-- The page shows the preview's tab in italics; tell it when that changes:
-- a file opened into it, an edit that keeps it, its tab closed.
function M.push_preview()
  local tab = M.preview_tab()
  if tab == shown_preview then return end
  shown_preview = tab
  M.notify("corkboard.preview", tab or vim.NIL)
end

local function open_in_preview(path)
  local file = vim.fn.fnameescape(path)
  -- Already open somewhere: go there, and leave that tab as it is.
  local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
  if buf ~= -1 and #vim.fn.win_findbuf(buf) > 0 then return vim.cmd("$tab drop " .. file) end
  local win = preview_win()
  if win then
    local old = preview.buf
    vim.api.nvim_set_current_win(win)
    vim.cmd.edit(file)
    -- The file it replaced is closed, as VS Code closes it, unless it's
    -- still shown elsewhere.
    if old ~= vim.api.nvim_get_current_buf() and #vim.fn.win_findbuf(old) == 0 and not vim.bo[old].modified then
      pcall(vim.api.nvim_buf_delete, old, {})
    end
  else
    vim.cmd("$tab drop " .. file)
  end
  local current = vim.api.nvim_get_current_buf()
  preview = { tab = vim.api.nvim_get_current_tabpage(), buf = current, tick = vim.api.nvim_buf_get_changedtick(current) }
  M.push_preview()
end

-- A click on a file in the browser. With tab (the file explorer), it opens
-- in the explorer's preview tab (above), or a tab of its own at the end, or
-- goes to the window already showing it. Otherwise it opens in the current
-- window if that holds a file, else the tab's first that does, else a new
-- split, so a panel or terminal is never replaced.
function M.open_file(path, tab)
  vim.schedule(function()
    vim.cmd.stopinsert()
    if tab then return open_in_preview(path) end
    local function editor(w)
      local b = vim.api.nvim_win_get_buf(w)
      return vim.api.nvim_win_get_config(w).relative == ""
        and (vim.bo[b].buftype == "" or vim.b[b].corkboard_file) and not M.is_panel(b)
    end
    local target = editor(vim.api.nvim_get_current_win()) and vim.api.nvim_get_current_win()
      or vim.tbl_filter(editor, vim.api.nvim_tabpage_list_wins(0))[1]
    if target then
      vim.api.nvim_set_current_win(target)
      vim.cmd.edit(vim.fn.fnameescape(path))
    else
      vim.cmd("rightbelow vsplit " .. vim.fn.fnameescape(path))
    end
  end)
end

-- Each window's status line names what is in it: a terminal by its program
-- and directory, the board as "Board", a file by its path with ● for unsaved
-- changes. Line and column only where the cursor means something.
function M.statusline()
  local win = vim.g.statusline_winid
  local buf = vim.api.nvim_win_get_buf(win)
  local name = vim.api.nvim_buf_get_name(buf)
  local esc = function(s) return (s:gsub("%%", "%%%%")) end

  local title, detail, pos = nil, nil, true
  local cwd, cmd = name:match("^term://(.-)//%d+:(.*)$")
  if cwd then
    title = vim.fs.basename(vim.split(cmd, " ", { trimempty = true })[1] or "terminal")
    detail, pos = vim.fn.fnamemodify(cwd, ":~"), false
  elseif vim.b[buf].corkboard_view == "board" then
    title, detail, pos = "Board", vim.fn.fnamemodify(vim.fn.getcwd(win), ":~"), false
  elseif vim.b[buf].corkboard_view == "plan" then
    title, detail, pos = "Day plan", os.date("%a %d %b"), false
  elseif vim.b[buf].corkboard_view == "plan-diff" then
    title, detail, pos = "Re-plan", "A accept · q keep old", false
  elseif vim.b[buf].corkboard_view == "markdown" then
    local src = vim.b[buf].corkboard_source
    local file = src and vim.api.nvim_buf_is_valid(src) and vim.api.nvim_buf_get_name(src) or ""
    title, detail, pos = "Preview", vim.fn.fnamemodify(file, ":~:."), false
  elseif name == "" then
    title = "[No Name]"
  else
    local path = vim.fn.fnamemodify(name, ":~:.")
    title, detail = vim.fs.basename(path), vim.fs.dirname(path)
    if detail == "." then detail = nil end
    if vim.b[buf].corkboard_file then pos = false end
  end

  local parts = { " ", esc(title) }
  if vim.bo[buf].modified then table.insert(parts, " ●") end
  if vim.bo[buf].readonly and vim.bo[buf].buftype == "" then table.insert(parts, " [ro]") end
  if detail then
    -- Dim in the focused window's bar; an unfocused bar is dim already.
    local current = win == vim.api.nvim_get_current_win()
    table.insert(parts, "  " .. (current and "%#CorkboardStatusDetail#" or "") .. esc(detail) .. "%*")
  end
  table.insert(parts, "%=")
  if pos then table.insert(parts, "%l:%c ") end
  return table.concat(parts)
end

-- Before closing wins, ask about each file with unsaved changes that no
-- other window shows; with 'hidden', :close would quietly keep them in the
-- background. Returns whether to go ahead, and the buffers to discard.
local function settle(wins)
  local closing = {}
  for _, w in ipairs(wins) do closing[w] = true end
  local discard = {}
  for _, w in ipairs(wins) do
    local b = vim.api.nvim_win_get_buf(w)
    local elsewhere = vim.tbl_contains(vim.tbl_map(function(o)
      return not closing[o] and vim.api.nvim_win_get_buf(o) == b
    end, vim.api.nvim_list_wins()), true)
    if vim.bo[b].modified and vim.bo[b].buftype == "" and not elsewhere and not vim.tbl_contains(discard, b) then
      local name = vim.api.nvim_buf_get_name(b)
      local shown = name == "" and "[No Name]" or vim.fn.fnamemodify(name, ":~:.")
      local choice = vim.fn.confirm(("Save changes to %s?"):format(shown), "&Save\n&Discard\n&Cancel", 1)
      if choice == 1 then
        if name == "" then
          name = vim.fn.input("Save as: ", "", "file")
          if name == "" then return false end
        end
        vim.api.nvim_buf_call(b, function() vim.cmd.write(vim.fn.fnameescape(name)) end)
      elseif choice == 2 then
        table.insert(discard, b)
      else
        return false
      end
    end
  end
  return true, discard
end

-- <C-q>: close the current window, or its tab when it is the last one, after
-- asking about unsaved changes. The board stays, since ensure() would only
-- bring it back.
function M.close()
  local win = vim.api.nvim_get_current_win()
  local ok, err = pcall(function()
    if vim.b.corkboard_view == "board" then
      return vim.notify("corkboard: the board stays open")
    end
    local float = vim.api.nvim_win_get_config(win).relative ~= ""
    local splits = vim.tbl_filter(function(w)
      return vim.api.nvim_win_get_config(w).relative == ""
    end, vim.api.nvim_tabpage_list_wins(0))
    local last_tab = #vim.api.nvim_list_tabpages() == 1
    if not float and #splits == 1 and last_tab then
      return vim.notify("corkboard: last window")
    end

    local go, discard = settle((float or #splits > 1) and { win } or vim.api.nvim_tabpage_list_wins(0))
    if not go then return end
    if float then
      vim.api.nvim_win_close(win, true)
    elseif #splits > 1 then
      vim.cmd("close!")
    else
      vim.cmd("tabclose!")
    end
    for _, b in ipairs(discard) do pcall(vim.api.nvim_buf_delete, b, { force = true }) end
  end)
  if not ok then vim.notify("corkboard: " .. tostring(err), vim.log.levels.ERROR) end
end

-- The + and * registers are the browser's clipboard: a copy goes to the page,
-- which works on a remote too. The page can't answer a synchronous read, so
-- "+p gives back the last copy from here; Ctrl+V pastes the real clipboard
-- through the page's paste event.
local clip = { lines = { "" }, regtype = "v" }
local function clip_copy(lines, regtype)
  clip = { lines = lines, regtype = regtype }
  M.notify("corkboard.clipboard", table.concat(lines, "\n") .. (regtype == "V" and "\n" or ""))
end
local function clip_paste() return { clip.lines, clip.regtype } end

function M.setup()
  vim.g.clipboard = {
    name = "corkboard",
    copy = { ["+"] = clip_copy, ["*"] = clip_copy },
    paste = { ["+"] = clip_paste, ["*"] = clip_paste },
  }

  -- Editor defaults.
  vim.o.number = true
  vim.o.relativenumber = true
  vim.o.statusline = "%!v:lua.require'corkboard'.statusline()"

  local board = require("corkboard.board")
  vim.keymap.set("n", "<leader>b", board.show, { desc = "corkboard: board" })
  vim.api.nvim_create_user_command("AgentBoard", board.show, { desc = "corkboard: board" })
  vim.api.nvim_create_user_command("AgentCard", function(args) board.card_from_code(args.line1, args.line2) end, {
    range = true,
    desc = "corkboard: card from these lines",
  })
  vim.keymap.set("n", "<leader>c", "<Cmd>AgentCard<CR>", { desc = "corkboard: card from this line" })
  vim.keymap.set("x", "<leader>c", ":AgentCard<CR>", { desc = "corkboard: card from the selection" })
  local usage = require("corkboard.usage")
  vim.keymap.set("n", "<leader>u", usage.show, { desc = "corkboard: token usage" })
  vim.api.nvim_create_user_command("AgentUsage", usage.show, { desc = "corkboard: token usage" })
  local plan = require("corkboard.plan")
  vim.keymap.set("n", "<leader>p", M.open_plan, { desc = "corkboard: day plan" })
  vim.api.nvim_create_user_command("AgentPlan", M.open_plan, { desc = "corkboard: day plan" })

  require("corkboard.viewer").setup()

  local picker = require("corkboard.picker")
  if picker.setup() then
    -- The tool picker, and editor-style shortcuts for some of its tools, from
    -- any mode. <C-f> replaces page down (<C-d> remains) and, in a terminal,
    -- readline's forward-char.
    vim.keymap.set({ "n", "i", "t" }, "<C-Space>", picker.tools, { desc = "corkboard: tools" })
    vim.keymap.set({ "n", "i", "t" }, "<C-S-p>", picker.tools, { desc = "corkboard: tools" })
    vim.keymap.set({ "n", "i", "t" }, "<C-f>", picker.files, { desc = "corkboard: find file" })
    vim.keymap.set({ "n", "i", "t" }, "<C-`>", require("corkboard.terminal").toggle, { desc = "corkboard: terminal" })
    vim.keymap.set({ "n", "i", "t" }, "<C-.>", require("corkboard.claude").open, { desc = "corkboard: Claude Code" })
    vim.keymap.set("n", "<leader>f", function() Snacks.picker.files() end, { desc = "find file" })
    vim.keymap.set("n", "<leader>g", function() Snacks.picker.grep() end, { desc = "grep" })
    vim.keymap.set("n", "<leader>,", function() Snacks.picker.buffers() end, { desc = "buffers" })
    vim.keymap.set("n", "<leader>r", function() Snacks.picker.recent() end, { desc = "recent files" })
  end

  -- Replaces <C-t>'s tag-stack pop.
  vim.keymap.set("n", "<C-t>", "<Cmd>tabnew<CR>", { desc = "corkboard: new tab" })
  -- Ctrl+Tab and Ctrl+Shift+Tab go through the tabs, from any mode; plain
  -- Tab stays the program's (completion, Claude Code's mode cycling).
  vim.keymap.set({ "n", "i", "t" }, "<C-Tab>", "<Cmd>tabnext<CR>", { desc = "corkboard: next tab" })
  vim.keymap.set({ "n", "i", "t" }, "<C-S-Tab>", "<Cmd>tabprevious<CR>", { desc = "corkboard: previous tab" })

  -- Ctrl+h/j/k/l moves between windows, from terminal mode too. Not insert
  -- mode, where <C-h> is backspace and <C-k> a digraph.
  for _, dir in ipairs({ "h", "j", "k", "l" }) do
    vim.keymap.set({ "n", "t" }, "<C-" .. dir .. ">", "<Cmd>wincmd " .. dir .. "<CR>", { desc = "corkboard: window " .. dir })
  end
  vim.keymap.set({ "n", "t" }, "<C-q>", M.close, { desc = "corkboard: close window or tab" })

  vim.api.nvim_set_decoration_provider(vim.api.nvim_create_namespace("corkboard.layout"), {
    on_end = M.push_layout,
  })
  local group = vim.api.nvim_create_augroup("corkboard", {})
  vim.api.nvim_create_autocmd("DirChanged", { group = group, callback = board.push })
  vim.api.nvim_create_autocmd({ "VimEnter", "DirChanged" }, { group = group, callback = remember_project })
  vim.api.nvim_create_autocmd({ "DirChanged", "BufEnter", "WinEnter", "TabEnter", "BufFilePost" }, {
    group = group,
    callback = function() M.push_context() end,
  })
  -- Terminals get the panels' inset: an empty sign column and winbar in the
  -- window's background. Set per buffer, so a file opened there is normal.
  vim.api.nvim_create_autocmd({ "TermOpen", "BufWinEnter" }, {
    group = group,
    callback = function(args)
      if vim.bo[args.buf].buftype ~= "terminal" then return end
      local wo = vim.wo[0][0]
      wo.signcolumn = "yes:1"
      wo.winbar = " "
      wo.winhighlight = "SignColumn:Normal,WinBar:Normal,WinBarNC:Normal"
    end,
  })
  -- Entering a terminal is entering terminal mode; <C-\><C-n> leaves it.
  vim.api.nvim_create_autocmd({ "TermOpen", "BufEnter", "WinEnter" }, {
    group = group,
    callback = function(args)
      if vim.bo[args.buf].buftype == "terminal" and vim.api.nvim_get_current_buf() == args.buf then vim.cmd.startinsert() end
    end,
  })
  -- A save can add a file, so the browser re-reads the folders it shows.
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = group,
    callback = function() M.notify("corkboard.files_changed") end,
  })
  -- An edit, or a closed tab, can end the explorer's preview.
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "TabClosed", "BufWinLeave" }, {
    group = group,
    callback = function() vim.schedule(M.push_preview) end,
  })
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = group,
    callback = function()
      status_highlights()
      M.push_theme()
    end,
  })
  status_highlights()
  -- Anything that could have closed or moved a pinned tab: the plan in the
  -- day plan's window, else the board and usage, in order, so each finds the
  -- ones before it already in place.
  vim.api.nvim_create_autocmd({ "VimEnter", "TabClosed", "TabNewEntered", "TabEnter", "WinClosed" }, {
    group = group,
    callback = function()
      vim.schedule(function()
        if M.window == "plan" then return plan.ensure() end
        board.ensure()
        usage.ensure()
      end)
    end,
  })
end

return M
