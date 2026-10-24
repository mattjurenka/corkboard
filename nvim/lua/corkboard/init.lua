-- The Neovim half of corkboard. The browser attaches its RPC channel here,
-- and everything the HTML panels show is pushed from this side with
-- rpcnotify, so state and keymaps live in Neovim.
--
-- An HTML panel is a real Neovim window: a scratch buffer with
-- b:corkboard_view set. The browser draws the panel over that window's
-- rectangle, so splits, tabs and <C-w> all apply to it.

local M = {}

local chans = {}
-- Declared before M.attach so its reset reaches the upvalue, not a global.
local last_layout = nil
local last_scroll = nil -- push_layout's scrollbars, likewise
local last_context = nil -- push_context's, for the same reason

-- Where the last project opened is kept; the bridge opens it when a page
-- names no ?cwd. Shared with bridge/server.ts, so not under stdpath().
local last_project_file = vim.fs.joinpath(
  vim.env.XDG_STATE_HOME or vim.fs.joinpath(vim.uv.os_homedir(), ".local/state"),
  "corkboard",
  "last-project"
)

-- Every project opened, newest first, for Open project. Its own file rather
-- than snacks' recent list, which it derives from oldfiles: the bridge
-- stops Neovim with SIGTERM when a window closes, and Neovim writes no
-- shada on a deadly signal, so oldfiles never learn anything. Written as
-- each project opens instead, like last-project. Per machine: a remote's
-- list is in that machine's state dir.
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

-- The statusline's dimmed folder: comment-coloured text. Foreground only,
-- so it lands on whichever bar it is in (a terminal's is StatusLineTerm,
-- not StatusLine). Again after every colorscheme, which clears it.
local function status_highlights()
  local dim = vim.api.nvim_get_hl(0, { name = "Comment", link = false })
  vim.api.nvim_set_hl(0, "CorkboardStatusDetail", { fg = dim.fg })
end

-- Called by the browser with its own channel id after nvim_ui_attach.
function M.attach(chan)
  chans[chan] = true
  -- By now every plugin has loaded, a colorscheme set from one included
  -- (stylix's sets highlights without a ColorScheme event).
  status_highlights()
  M.push_theme()
  last_context = nil -- the new channel has seen nothing yet
  M.push_context()
  require("corkboard.board").push()
  require("corkboard.viewer").push_all()
  require("corkboard.usage").push_all()
  last_layout = nil -- the new channel has seen nothing yet
  last_scroll = nil
  M.push_layout()
end

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

-- Checked after every redraw, sent only when it changed. Window events are
-- not enough: plugins move floats with nvim_win_set_config, which fires no
-- autocommand, but every visible change redraws.
--
-- Sent synchronously from the redraw, not scheduled: on_end runs before
-- Neovim flushes the grid to the UI, so the browser places a panel before
-- it paints the text beneath it. Scheduled, the layout came one flush late
-- and the view buffer's text showed for a frame on every tab switch.
function M.push_layout()
  local layout = M.layout()
  local key = vim.json.encode(layout)
  if key ~= last_layout then
    last_layout = key
    M.notify("corkboard.layout", layout)
  end
  -- Apart from the layout, which redraws every panel: scrolling changes
  -- this on nearly every redraw.
  local scroll = { bars = M.scrollbars(), floats = layout.floats }
  key = vim.json.encode(scroll)
  if key ~= last_scroll then
    last_scroll = key
    M.notify("corkboard.scroll", scroll)
  end
end

-- Every split in the current tabpage showing text, and how far it is
-- scrolled, for the browser's scrollbars: its rectangle in grid cells
-- (status line excluded), the first and last lines on screen and the
-- buffer's length. Not terminals, whose scrollback is not lines to jump
-- to, or panels.
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

-- The HTML panels' accents, from highlight groups every colorscheme sets,
-- so they follow it like the background and text already do (those come
-- with the grid's default colors). The font is optional:
-- vim.g.corkboard_font = { family = ..., size = ... }, set by whatever
-- installs the colorscheme (the stylix module in nixosconfig).
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
    font = vim.g.corkboard_font,
  })
end

-- What the sidebar shows besides tabs: the project (the cwd) and the file
-- in the current window, which the file browser highlights. Sent when either
-- changes.
function M.push_context()
  local buf = vim.api.nvim_get_current_buf()
  local file = (vim.bo[buf].buftype == "" or vim.b[buf].corkboard_file) and vim.api.nvim_buf_get_name(buf) or ""
  local context = { cwd = vim.fn.getcwd(), file = file ~= "" and file or nil }
  local key = vim.json.encode(context)
  if key == last_context then return end
  last_context = key
  M.notify("corkboard.context", context)
end

-- One directory for the file browser: folders first, then files, by name.
-- .git is left out; what git ignores is marked so the browser can dim it, and
-- what has changed since the last commit is marked so it can colour it. A
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

-- A click on a file in the browser. It goes to the tab's editor window: the
-- current one if it holds a file, else the first that does, else a split
-- beside the current window, so the board, Claude or a terminal is never
-- replaced.
function M.open_file(path)
  vim.schedule(function()
    vim.cmd.stopinsert()
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

-- Each window's status line: what is in it, by the name a person would use.
-- A terminal (term://<cwd>//<pid>:<cmd>) is its program and where it runs,
-- the board is "Board", a file is its path from the cwd with ● for unsaved
-- changes. Line and column only where there is a cursor worth reading.
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

-- Before closing wins: asks about each file with unsaved changes that no
-- other window still shows. 'hidden' means :close would keep them quietly
-- in the background, which is how changes get forgotten. Returns whether to
-- go ahead, and the buffers whose changes were discarded.
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

-- <C-q>: the current window, or its tab when it is the tab's last one.
-- Unsaved changes are asked about first (settle). A terminal's shell keeps
-- running. The board is left alone, since board.ensure would only bring it
-- back.
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

-- The + and * registers are the browser's clipboard. A copy is pushed to the
-- page, which writes it with navigator.clipboard; that works the same on a
-- remote, where Neovim has no wl-copy and no display to reach. Paste cannot
-- go the other way (the page cannot answer a synchronous read), so "+p
-- gives back the last thing copied from here. Ctrl+V reads the real
-- clipboard instead, through the page's paste event and nvim_paste.
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
  local usage = require("corkboard.usage")
  vim.keymap.set("n", "<leader>u", usage.show, { desc = "corkboard: token usage" })
  vim.api.nvim_create_user_command("AgentUsage", usage.show, { desc = "corkboard: token usage" })

  require("corkboard.viewer").setup()

  local picker = require("corkboard.picker")
  if picker.setup() then
    -- The browser sends Ctrl+Space as <C-Space>. Terminal and insert mode
    -- too, so it opens from a terminal or mid-edit.
    vim.keymap.set({ "n", "i", "t" }, "<C-Space>", picker.tools, { desc = "corkboard: tools" })
    -- And as a command palette. The browser sends Ctrl+Shift+P as <C-S-p>.
    vim.keymap.set({ "n", "i", "t" }, "<C-S-p>", picker.tools, { desc = "corkboard: tools" })
    -- Editor-style shortcuts for two of the tools, from any mode like
    -- <C-Space>. <C-f> replaces normal mode's page down (<C-d> is still
    -- there) and, in a terminal, readline's forward-char (the arrow is too).
    vim.keymap.set({ "n", "i", "t" }, "<C-f>", picker.files, { desc = "corkboard: find file" })
    vim.keymap.set({ "n", "i", "t" }, "<C-`>", picker.terminal, { desc = "corkboard: terminal" })
    vim.keymap.set("n", "<leader>f", function() Snacks.picker.files() end, { desc = "find file" })
    vim.keymap.set("n", "<leader>g", function() Snacks.picker.grep() end, { desc = "grep" })
    vim.keymap.set("n", "<leader>,", function() Snacks.picker.buffers() end, { desc = "buffers" })
    vim.keymap.set("n", "<leader>r", function() Snacks.picker.recent() end, { desc = "recent files" })
  end

  -- Replaces <C-t>'s tag-stack pop.
  vim.keymap.set("n", "<C-t>", "<Cmd>tabnew<CR>", { desc = "corkboard: new tab" })
  -- The browser sends <Tab> and <C-i> as different keys, so the jumplist's
  -- <C-i> keeps working. In a terminal without extended keys they are one key.
  vim.keymap.set("n", "<Tab>", "<Cmd>tabnext<CR>", { desc = "corkboard: next tab" })
  vim.keymap.set("n", "<S-Tab>", "<Cmd>tabprevious<CR>", { desc = "corkboard: previous tab" })
  -- The same from any mode. A terminal keeps plain Tab and Shift+Tab for
  -- its program (completion; Claude Code's mode cycling), so these are how
  -- to leave a Claude or terminal tab without <C-\><C-n> first.
  vim.keymap.set({ "n", "i", "t" }, "<C-Tab>", "<Cmd>tabnext<CR>", { desc = "corkboard: next tab" })
  vim.keymap.set({ "n", "i", "t" }, "<C-S-Tab>", "<Cmd>tabprevious<CR>", { desc = "corkboard: previous tab" })

  -- Ctrl+h/j/k/l moves to the window in that direction. Terminal mode too, so
  -- a terminal can be left without <C-\><C-n> first; not insert mode, where
  -- <C-h> is backspace and <C-k> enters a digraph.
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
  -- Terminals (Claude Code, shells) get the board and usage panels' inset:
  -- an empty sign column on the left (the program's width shrinks to fit)
  -- and an empty winbar on top, both in the window's background. Local to
  -- the terminal buffer, so a file opened in the window goes back to normal.
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
  -- Every window starts in normal mode, terminals included (i to type into
  -- one), and <C-n> leaves terminal mode in any of them instead of
  -- <C-\><C-n>. That costs readline's next-history in a shell, which the
  -- down arrow still is.
  vim.keymap.set("t", "<C-n>", [[<C-\><C-n>]], { desc = "corkboard: normal mode" })
  -- A save can add a file, so the browser re-reads the folders it shows.
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = group,
    callback = function() M.notify("corkboard.files_changed") end,
  })
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = group,
    callback = function()
      status_highlights()
      M.push_theme()
    end,
  })
  status_highlights()
  -- Anything that could have closed or moved the board or usage tab.
  vim.api.nvim_create_autocmd({ "VimEnter", "TabClosed", "TabNewEntered", "TabEnter", "WinClosed" }, {
    group = group,
    callback = function()
      vim.schedule(function()
        board.ensure()
        usage.ensure()
      end)
    end,
  })
end

return M
