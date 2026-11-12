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

local chans = {}
-- What each channel was last sent, so unchanged state isn't sent again.
-- shown_preview: the preview tab last sent (M.push_preview); false when
-- the page has been sent nothing.
local last_layout, last_scroll, last_context, last_labels
local shown_preview = false

-- The last project opened, which the bridge opens when a page names no
-- ?cwd. Shared with bridge/server.ts, so not under stdpath().
local last_project_file = require("corkboard.util").state_dir("last-project")

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

-- Take dir off the recent projects, and off the last one opened.
function M.forget_project(dir)
  local left = vim.tbl_filter(function(d) return d ~= dir end, M.recent_projects())
  pcall(vim.fn.writefile, left, projects_file)
  local ok, last = pcall(vim.fn.readfile, last_project_file)
  if ok and last[1] == dir then pcall(vim.fn.delete, last_project_file) end
end

-- Home is where corkboard lands without a project, so it is not one. A
-- subdirectory or worktree is remembered as its repository.
local function remember_project()
  local cwd = vim.fn.getcwd(-1, -1)
  if cwd == vim.uv.os_homedir() then return end
  local root = require("corkboard.util").project_root(cwd)
  vim.fn.mkdir(vim.fs.dirname(last_project_file), "p")
  pcall(vim.fn.writefile, { root }, last_project_file)
  local projects = { root }
  for _, dir in ipairs(M.recent_projects()) do
    if dir ~= root and #projects < max_projects then table.insert(projects, dir) end
  end
  pcall(vim.fn.writefile, projects, projects_file)
end

-- The statusline's dimmed folder, in Comment's colour, and a Claude Code
-- session's context once it's too big, in DiagnosticWarn's. Foreground only,
-- so they suit whichever bar they are in (a terminal's is StatusLineTerm).
-- Set again after every colorscheme, which clears them.
local function status_highlights()
  local dim = vim.api.nvim_get_hl(0, { name = "Comment", link = false })
  vim.api.nvim_set_hl(0, "CorkboardStatusDetail", { fg = dim.fg })
  local warn = vim.api.nvim_get_hl(0, { name = "DiagnosticWarn", link = false })
  vim.api.nvim_set_hl(0, "CorkboardStatusWarn", { fg = warn.fg })
end

-- Called by the browser with its own channel id after nvim_ui_attach.
function M.attach(chan)
  chans[chan] = true
  -- By now every plugin has loaded, including a colorscheme that set its
  -- highlights without a ColorScheme event (stylix's).
  status_highlights()
  M.push_theme()
  -- The new channel has seen nothing yet.
  last_context, last_layout, last_scroll, last_labels, shown_preview = nil, nil, nil, nil, false
  require("corkboard.minimap").reset()
  vim.schedule(M.push_preview)
  M.push_context()
  require("corkboard.features").push()
  require("corkboard.vimkeys").push()
  require("corkboard.projects").push_all()
  require("corkboard.board").push_all()
  require("corkboard.viewer").push_all()
  require("corkboard.claude.cards").push_all()
  require("corkboard.usage").push_all()
  require("corkboard.fleet").push_all()
  require("corkboard.brains").push_all()
  require("corkboard.plan").push_all()
  require("corkboard.settings").push_all()
  require("corkboard.meetings").push_all()
  require("corkboard.focus").push()
  M.push_layout()
  -- Once the grid has its size, so the windows come back in proportion.
  vim.schedule(require("corkboard.restore").restore)
end

-- Whether a page is attached.
function M.attached() return next(chans) ~= nil end

-- A narrow page (a phone, a skinny window) is one column: nothing opens
-- beside a window by itself (the cards beside a session, a markdown
-- preview), and a file opened from a panel gets a tab of its own. The page
-- says which it is (main.tsx); User CorkboardNarrow tells the rest.
function M.narrow() return vim.g.corkboard_narrow == true end

function M.set_narrow(on)
  if M.narrow() == on then return end
  vim.g.corkboard_narrow = on
  vim.api.nvim_exec_autocmds("User", { pattern = "CorkboardNarrow" })
end

-- What another window sent this one to do (corkboard.open's run, from the
-- bridge): require(mod)[fn](...), once the editor is put back, which would
-- move off it.
function M.handoff(mod, fn, ...)
  local args, deadline = vim.F.pack_len(...), vim.uv.now() + 10000
  local function go()
    if not require("corkboard.restore").restored() and vim.uv.now() < deadline then return vim.defer_fn(go, 50) end
    require(mod)[fn](vim.F.unpack_len(args))
  end
  go()
end

function M.notify(method, ...)
  for chan in pairs(chans) do
    if not pcall(vim.rpcnotify, chan, method, ...) then chans[chan] = nil end
  end
end

-- A popup (a card, a review): focus going elsewhere (Alt+h/j/k/l, a click
-- off it) closes it, saving edits, and the page draws an × on its top
-- right corner (M.layout).
function M.popup(win)
  vim.w[win].corkboard_popup = true
  local group = vim.api.nvim_create_augroup("corkboard.popup" .. win, {})
  vim.api.nvim_create_autocmd("WinClosed", {
    group = group,
    pattern = tostring(win),
    once = true,
    callback = function() vim.api.nvim_del_augroup_by_id(group) end,
  })
  vim.api.nvim_create_autocmd("WinLeave", {
    group = group,
    callback = function()
      if vim.api.nvim_get_current_win() ~= win then return end
      vim.schedule(function()
        if vim.api.nvim_win_is_valid(win) and vim.api.nvim_get_current_win() ~= win then M.close_popup(win) end
      end)
    end,
  })
end

-- The × clicked, or focus gone.
function M.close_popup(win)
  if not vim.api.nvim_win_is_valid(win) then return end
  vim.api.nvim_win_call(win, function() vim.cmd("silent! update") end)
  pcall(vim.api.nvim_win_close, win, true)
end

-- A toast in the page's corner: kind is "pending", "done" or "error"; the
-- same id again replaces it. With no page, only how it ended, as a message.
function M.toast(id, kind, text)
  if M.attached() then return M.notify("corkboard.toast", { id = id, kind = kind, text = text }) end
  if kind ~= "pending" then vim.notify("corkboard: " .. text, kind == "error" and vim.log.levels.WARN or nil) end
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
-- browser must not cover, the popups (M.popup) it draws an × on, and the
-- focused window (with its status line),
-- which the browser outlines. In grid cells.
-- Also every split, and whether its content is still coming (a terminal
-- put back that has drawn nothing yet), and whether the editor has been put
-- back at all, for the page to show what is loading.
function M.layout()
  local views, floats, wins, popups, current = {}, {}, {}, {}, vim.api.nvim_get_current_win()
  local restore = require("corkboard.restore")
  local splits, focus = 0, nil
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local config = vim.api.nvim_win_get_config(win)
    local buf = vim.api.nvim_win_get_buf(win)
    local view = vim.b[buf].corkboard_view
    local floating = config.relative ~= ""
    if not floating then
      splits = splits + 1
      if win == current then focus = rect(win, config) end
      table.insert(wins, vim.tbl_extend("error", rect(win, config), { loading = restore.loading(buf) or nil }))
    end
    if floating and vim.w[win].corkboard_popup then
      table.insert(popups, vim.tbl_extend("error", rect(win, config), { win = win }))
    end
    if view then
      table.insert(views, vim.tbl_extend("error", rect(win, config), {
        win = win,
        buf = buf,
        view = view,
        focused = win == current,
        float = floating,
        -- The panel covers a float's border, so the browser draws it, and
        -- its title on it.
        border = floating and type(config.border) == "table" and #config.border == 8 or nil,
        title = type(config.title) == "table"
            and vim.trim(table.concat(vim.tbl_map(function(c) return c[1] end, config.title)))
          or nil,
      }))
    elseif floating and not config.hide then
      table.insert(floats, rect(win, config))
    end
  end
  -- Its own status line: always with laststatus=2, with 1 only when split.
  if focus and (vim.o.laststatus == 2 or (vim.o.laststatus == 1 and splits > 1)) then
    focus.height = focus.height + 1
  end
  -- A window beside another has a separator column between them, which the
  -- browser draws as a line down its middle and runs the outline along.
  if focus then
    focus.left = focus.col > 0 or nil
    focus.right = focus.col + focus.width < vim.o.columns or nil
  end
  return { views = views, floats = floats, popups = popups, focus = focus, wins = wins, restored = restore.restored() }
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
  require("corkboard.minimap").check(vim.tbl_map(function(bar) return bar.buf end, scroll.bars))
  key = vim.json.encode(scroll)
  if key ~= last_scroll then
    last_scroll = key
    M.notify("corkboard.scroll", scroll)
  end
  local labels = M.tab_labels()
  key = vim.json.encode(labels)
  if key ~= last_labels then
    last_labels = key
    M.notify("corkboard.tab_labels", labels)
  end
end

-- Names for the page's tabs where the buffer's own reads badly: a Claude
-- Code session's is the tmux command that runs it. With its kind (project,
-- card or pepper), which the page marks, and its state from its hooks
-- (corkboard.agents), which the page animates while working. By tab handle;
-- the page names the rest from their buffers.
-- Each from the tab's main window, its top left, not the focused one: a
-- session's tab is named for the session while its cards panel has the
-- keys. names: that window's buffer name, as ext_tabline would send it
-- (relative, or with ~), which the page uses in place of the focused one's.
function M.tab_labels()
  local labels, names = vim.empty_dict(), vim.empty_dict()
  for nr, tab in ipairs(vim.api.nvim_list_tabpages()) do
    local buf = vim.api.nvim_win_get_buf(vim.fn.win_getid(1, nr))
    local name = vim.fn.bufname(buf)
    names[tostring(tab)] = name:sub(1, 1) == "/" and vim.fn.fnamemodify(name, ":~") or name
    local kind = vim.b[buf].corkboard_agent and vim.b[buf].corkboard_role
    if kind then labels[tostring(tab)] = {
        title = require("corkboard.session").title(buf),
        where = require("corkboard.session").where(buf, true),
        kind = kind,
        state = require("corkboard.agents").state(buf),
      } end
  end
  return { labels = labels, names = names }
end

-- For the browser's scrollbars: each split in the tab showing text, as its
-- rectangle in grid cells (status line excluded), the first and last lines
-- on screen, the cursor's line, the lines changed since the last commit
-- (corkboard.gitlines),
-- and the buffer and its length (its text goes to the minimap,
-- corkboard.minimap). Not terminals or panels.
function M.scrollbars()
  local bars = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local buf = vim.api.nvim_win_get_buf(win)
    if vim.api.nvim_win_get_config(win).relative == "" and not vim.b[buf].corkboard_view
      and vim.bo[buf].buftype ~= "terminal" then
      local info = vim.fn.getwininfo(win)[1]
      table.insert(bars, {
        win = win,
        buf = buf,
        row = info.winrow - 1,
        col = info.wincol - 1,
        width = info.width,
        height = info.height,
        top = info.topline,
        bottom = info.botline,
        lines = vim.api.nvim_buf_line_count(buf),
        cursor = vim.api.nvim_win_get_cursor(win)[1],
        git = require("corkboard.gitlines").ranges(buf),
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
-- font: vim.g.corkboard_font = { family = ..., size = ... }, at vim.g.corkboard_zoom
-- percent (Ctrl+= and Ctrl+-, settings.lua). Each color can be
-- set instead: vim.g.corkboard_colors = { focus = "#rrggbb", ... } (the
-- Settings tab's). colorscheme: the colorscheme's alone.
function M.theme(colorscheme)
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
  local theme = {
    -- Where you are: the focused window's outline, the current tab's, the
    -- pinned tabs. Type is the yellow in base16 (stylix's base0A) and most
    -- schemes; vim.g.corkboard_focus_hl names another group.
    focus = fg(vim.g.corkboard_focus_hl or "Type", "Function"),
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
  }
  if not colorscheme then theme = vim.tbl_extend("force", theme, vim.g.corkboard_colors or {}) end
  return theme
end

function M.push_theme()
  M.notify("corkboard.theme", vim.tbl_extend("force", M.theme(), { font = vim.g.corkboard_font, zoom = vim.g.corkboard_zoom }))
end

-- The cwd and the current window's file, for the sidebar, the project
-- (the global cwd), which the bridge knows the window by, and whether
-- there is none yet (util.no_project), which the page greys out for.
function M.push_context()
  local buf = vim.api.nvim_get_current_buf()
  local file = (vim.bo[buf].buftype == "" or vim.b[buf].corkboard_file) and vim.api.nvim_buf_get_name(buf) or ""
  local context = { cwd = vim.fn.getcwd(), project = vim.fn.getcwd(-1, -1), file = file ~= "" and file or nil, none = require("corkboard.util").no_project() or nil }
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
  -- Without the index refreshed on disk: the browser watches it (watch_dirs),
  -- and a session's own git may hold its lock.
  local result = vim.system({ "git", "status", "--porcelain", "-z", "--untracked-files=normal", "--", "." }, { cwd = dir, env = { GIT_OPTIONAL_LOCKS = "0" } }):wait()
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

-- The folders the file browser has open, and the repository's index, watched
-- so that what a session, git or a terminal does shows without a save here.
local browser_dirs, browser_index, browser_watchers = {}, nil, {}

local function watch_browser()
  for _, w in ipairs(browser_watchers) do w:close() end
  browser_watchers = {}
  local function watch(path, on_event)
    local w = vim.uv.new_fs_event()
    if not w then return end
    if w:start(path, {}, on_event) then table.insert(browser_watchers, w) else w:close() end
  end
  for _, dir in ipairs(browser_dirs) do
    watch(dir, function() M.files_changed() end)
  end
  -- A commit, a stage or a checkout changes what git marks, and may touch
  -- no folder that is open.
  if browser_index then
    watch(browser_index, function(_, name)
      if name == nil or name == "index" then M.files_changed() end
    end)
  end
end

-- Tell the browser to re-read its folders. A build or a checkout touches
-- many files at once, so settle first. The folders are watched afresh: one
-- deleted and made again is a new folder to the watcher.
local files_pending = false
function M.files_changed()
  if files_pending then return end
  files_pending = true
  vim.defer_fn(function()
    files_pending = false
    watch_browser()
    M.notify("corkboard.files_changed")
  end, 200)
end

-- The page says which folders it shows, each time one opens or shuts.
function M.watch_dirs(dirs)
  browser_dirs = dirs
  local git = vim.system({ "git", "rev-parse", "--absolute-git-dir" }, { cwd = vim.fn.getcwd() }):wait()
  browser_index = git.code == 0 and vim.trim(git.stdout) or nil
  watch_browser()
end

-- An HTML panel such as the board or a markdown preview, as opposed to a
-- file an HTML viewer draws (an image, a PDF; see corkboard.viewer).
function M.is_panel(buf)
  return vim.b[buf].corkboard_view ~= nil and not vim.b[buf].corkboard_file
end

-- <leader>p, :AgentPlan: the day plan, which has a window of its own. Here,
-- that's the plan's tab; in a project's window, the page opens the plan's
-- window, or brings it forward if it's open. Only while the assistant's
-- parts are on (corkboard.features).
function M.open_plan()
  if M.window == "plan" then return require("corkboard.plan").show() end
  if not require("corkboard.features").on("assistant") then return end
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
-- split (a tab, when narrow), so a panel or terminal is never replaced.
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
      vim.cmd((M.narrow() and "$tabedit " or "rightbelow vsplit ") .. vim.fn.fnameescape(path))
    end
  end)
end

-- This plugin's commit: its repo's, or the one the flake wrote beside it
-- (nvim/rev). Asked once, in the background.
local version
local function plugin_version()
  if version then return version end
  version = "?"
  local root = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))))
  vim.system({ "git", "-C", root, "describe", "--always", "--dirty" }, { text = true }, function(r)
    local v = r.code == 0 and vim.trim(r.stdout) or nil
    if not v then
      local f = io.open(root .. "/rev")
      v = f and vim.trim(f:read("*a")) or "?"
      if f then f:close() end
    end
    version = v
    vim.schedule(function() vim.cmd.redrawstatus({ bang = true }) end)
  end)
  return version
end

-- The window in the bottom right corner, whose status line ends the screen's.
local function corner(win)
  local best, bottom, right
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(vim.api.nvim_win_get_tabpage(win))) do
    if vim.api.nvim_win_get_config(w).relative == "" then
      local pos = vim.api.nvim_win_get_position(w)
      local b, r = pos[1] + vim.api.nvim_win_get_height(w), pos[2] + vim.api.nvim_win_get_width(w)
      if not best or b > bottom or (b == bottom and r > right) then best, bottom, right = w, b, r end
    end
  end
  return best == win
end

-- Each window's status line names what is in it: a Claude Code session by
-- where it runs, a terminal by its program and directory, the board as
-- "Board", a file by its path with ● for unsaved changes. Line and column
-- only where the cursor means something.
function M.statusline()
  local win = vim.g.statusline_winid
  local buf = vim.api.nvim_win_get_buf(win)
  local name = vim.api.nvim_buf_get_name(buf)
  local esc = function(s) return (s:gsub("%%", "%%%%")) end

  local title, detail, pos = nil, nil, true
  local cwd, cmd = name:match("^term://(.-)//%d+:(.*)$")
  if vim.b[buf].corkboard_plan_claude then
    title, detail, pos = "Pepper", "beside the day plan", false
  elseif vim.b[buf].corkboard_vm or vim.b[buf].corkboard_agent then
    title, pos = require("corkboard.session").where(buf), false
  elseif cwd then
    title = vim.fs.basename(vim.split(cmd, " ", { trimempty = true })[1] or "terminal")
    detail, pos = vim.fn.fnamemodify(cwd, ":~"), false
  elseif vim.b[buf].corkboard_view == "board" then
    title, detail, pos = "Board", vim.fn.fnamemodify(vim.fn.getcwd(win), ":~"), false
  elseif vim.b[buf].corkboard_view == "plan" then
    title, detail, pos = "Day plan", os.date("%a %d %b"), false
  elseif vim.b[buf].corkboard_view == "plan-diff" then
    title, detail, pos = "Re-plan", "A accept · q keep old", false
  elseif vim.b[buf].corkboard_view == "plan-goals" then
    title, detail, pos = "Goals", nil, false
  elseif vim.b[buf].corkboard_view == "plan-priority" then
    title, detail, pos = "Priority", nil, false
  elseif vim.b[buf].corkboard_view == "brain-memory" then
    title, detail, pos = "Memory", name:match("^agent://brains/(.+)$"), false
  elseif vim.b[buf].corkboard_view == "holds" then
    title, pos = "Holds", false
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
  -- A Claude Code session's context, as of its last request
  -- (corkboard.agents), warning past the point where it's worth starting
  -- fresh.
  local context = vim.b[buf].corkboard_context
  if context then
    local over = context >= require("corkboard.agents").context_limit()
    local text = string.format("%dk context%s ", math.floor(context / 1000 + 0.5), over and " · /clear?" or "")
    table.insert(parts, (over and "%#CorkboardStatusWarn#" or "") .. text .. "%*")
  end
  if pos then table.insert(parts, "%l:%c ") end
  -- The bottom right one ends with corkboard's and the bridge's versions.
  if corner(win) then
    local current = win == vim.api.nvim_get_current_win()
    local text = ("corkboard %s · bridge %s "):format(plugin_version(), vim.env.CORKBOARD_BRIDGE_VERSION or "?")
    table.insert(parts, " " .. (current and "%#CorkboardStatusDetail#" or "") .. esc(text) .. "%*")
  end
  return table.concat(parts)
end

-- Before closing wins, ask about each file with unsaved changes that no
-- other window shows; with 'hidden', :close would quietly keep them in the
-- background. done gets the buffers to discard, once each is answered; a
-- cancel, or a failed write, never calls it.
local function settle(wins, done)
  local closing = {}
  for _, w in ipairs(wins) do closing[w] = true end
  local discard, at = {}, 0
  local function step()
    at = at + 1
    local w = wins[at]
    if not w then return done(discard) end
    if not vim.api.nvim_win_is_valid(w) then return step() end
    local b = vim.api.nvim_win_get_buf(w)
    local elsewhere = vim.tbl_contains(vim.tbl_map(function(o)
      return not closing[o] and vim.api.nvim_win_get_buf(o) == b
    end, vim.api.nvim_list_wins()), true)
    if not vim.bo[b].modified or vim.bo[b].buftype ~= "" or elsewhere or vim.tbl_contains(discard, b) then return step() end
    local name = vim.api.nvim_buf_get_name(b)
    local shown = name == "" and "[No Name]" or vim.fn.fnamemodify(name, ":~:.")
    local function write(path)
      local ok, err = pcall(vim.api.nvim_buf_call, b, function() vim.cmd.write(vim.fn.fnameescape(path)) end)
      if not ok then return vim.notify("corkboard: " .. tostring(err), vim.log.levels.ERROR) end
      step()
    end
    vim.ui.select({ "Save", "Discard", "Cancel" }, { prompt = ("Save changes to %s?"):format(shown) }, function(_, choice)
      if choice == 1 then
        if name ~= "" then return write(name) end
        vim.ui.input({ prompt = "Save as: ", completion = "file" }, function(path)
          if path and vim.trim(path) ~= "" then write(vim.trim(path)) end
        end)
      elseif choice == 2 then
        table.insert(discard, b)
        step()
      end
    end)
  end
  step()
end

-- <A-q>: close the current window, or its tab when it is the last one, after
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

    settle((float or #splits > 1) and { win } or vim.api.nvim_tabpage_list_wins(0), function(discard)
      local done, e = pcall(function()
        -- Answered on the page, so the window may have gone meanwhile.
        if not vim.api.nvim_win_is_valid(win) then return end
        vim.api.nvim_set_current_win(win)
        if float then
          vim.api.nvim_win_close(win, true)
        elseif #splits > 1 then
          vim.cmd("close!")
        else
          vim.cmd("tabclose!")
        end
        for _, b in ipairs(discard) do pcall(vim.api.nvim_buf_delete, b, { force = true }) end
      end)
      if not done then vim.notify("corkboard: " .. tostring(e), vim.log.levels.ERROR) end
    end)
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

-- To the tab a step away, round from one end to the other.
local function tab_step(step)
  local n = vim.fn.tabpagenr("$")
  vim.cmd.tabnext((vim.fn.tabpagenr() - 1 + step) % n + 1)
end

-- Warnings and errors go to the page's notifications (the sidebar's foot),
-- not the command line, while there's a page to show them.
local notify = vim.notify
local function notify_page(msg, level, opts)
  if (level or 0) < vim.log.levels.WARN or not M.attached() then return notify(msg, level, opts) end
  M.notify("corkboard.message", {
    level = level >= vim.log.levels.ERROR and "error" or "warning",
    text = tostring(msg):gsub("^corkboard: ", ""),
  })
end

function M.setup()
  vim.notify = notify_page
  require("corkboard.ask").setup()
  vim.g.clipboard = {
    name = "corkboard",
    copy = { ["+"] = clip_copy, ["*"] = clip_copy },
    paste = { ["+"] = clip_paste, ["*"] = clip_paste },
  }

  -- Editor defaults.
  -- Relative too while Vim's keys are on (corkboard.vimkeys).
  vim.o.number = true
  vim.o.statusline = "%!v:lua.require'corkboard'.statusline()"

  local board = require("corkboard.board")
  vim.keymap.set("n", "<leader>b", board.show, { desc = "corkboard: board" })
  vim.api.nvim_create_user_command("AgentBoard", board.show, { desc = "corkboard: board" })
  vim.api.nvim_create_user_command("AgentProjects", function() require("corkboard.projects").show() end, { desc = "corkboard: projects" })
  vim.api.nvim_create_user_command("AgentCard", function(args) board.card_from_code(args.line1, args.line2) end, {
    range = true,
    desc = "corkboard: card from these lines",
  })
  vim.keymap.set("n", "<leader>c", "<Cmd>AgentCard<CR>", { desc = "corkboard: card from this line" })
  vim.keymap.set("x", "<leader>c", ":AgentCard<CR>", { desc = "corkboard: card from the selection" })
  local autopilot = require("corkboard.autopilot")
  vim.api.nvim_create_user_command("AgentGroom", autopilot.groom, { desc = "corkboard: groom the board now" })
  vim.api.nvim_create_user_command("AgentUndoGroom", autopilot.undo_groom, { desc = "corkboard: undo the last grooming" })
  local usage = require("corkboard.usage")
  vim.keymap.set("n", "<leader>u", usage.show, { desc = "corkboard: token usage" })
  vim.api.nvim_create_user_command("AgentUsage", usage.show, { desc = "corkboard: token usage" })
  local fleet = require("corkboard.fleet")
  vim.api.nvim_create_user_command("AgentFleet", fleet.show, { desc = "corkboard: the fleet" })
  local brains = require("corkboard.brains")
  vim.api.nvim_create_user_command("AgentBrains", brains.show, { desc = "corkboard: brains" })
  local plan = require("corkboard.plan")
  vim.keymap.set("n", "<leader>p", M.open_plan, { desc = "corkboard: day plan" })
  vim.api.nvim_create_user_command("AgentPlan", M.open_plan, { desc = "corkboard: day plan" })

  require("corkboard.pair").setup()
  require("corkboard.viewer").setup()
  require("corkboard.gitlines").setup()
  require("corkboard.claude.cards").setup()
  require("corkboard.avatar").setup()
  require("corkboard.restore").setup()
  require("corkboard.focus").setup()
  require("corkboard.away").setup()
  require("corkboard.settings").setup()
  require("corkboard.meetings").setup()

  -- Each shortcut has a Ctrl or Alt chord, for Linux and Windows, and most
  -- have a Cmd one (<D-...>) for macOS, where Option types the layout's
  -- characters (@ and brackets, on many) and Ctrl+Space switches the input
  -- source. The page sends Cmd chords only on a Mac and only those in
  -- input.js's CMD, since one Neovim doesn't map it types itself out.
  local picker = require("corkboard.picker")
  if picker.setup() then
    -- The tool picker, and editor-style shortcuts for some of its tools, from
    -- any mode. <C-f> replaces page down (<C-d> remains) and, in a terminal,
    -- readline's forward-char.
    vim.keymap.set({ "n", "i", "t" }, "<C-Space>", picker.tools, { desc = "corkboard: tools" })
    vim.keymap.set({ "n", "i", "t" }, "<M-Space>", picker.tools, { desc = "corkboard: tools" })
    vim.keymap.set({ "n", "i", "t" }, "<C-S-p>", picker.tools, { desc = "corkboard: tools" })
    vim.keymap.set({ "n", "i", "t" }, "<D-S-p>", picker.tools, { desc = "corkboard: tools" })
    vim.keymap.set({ "n", "i", "t" }, "<C-f>", picker.files, { desc = "corkboard: find file" })
    vim.keymap.set({ "n", "i", "t" }, "<D-p>", picker.files, { desc = "corkboard: find file" })
    vim.keymap.set({ "n", "i", "t" }, "<C-`>", require("corkboard.terminal").toggle, { desc = "corkboard: terminal" })
    vim.keymap.set({ "n", "i", "t" }, "<C-.>", require("corkboard.session").open, { desc = "corkboard: new session" })
    vim.keymap.set("n", "<leader>f", function() Snacks.picker.files() end, { desc = "find file" })
    vim.keymap.set("n", "<leader>g", function() Snacks.picker.grep() end, { desc = "grep" })
    vim.keymap.set("n", "<leader>,", function() Snacks.picker.buffers() end, { desc = "buffers" })
    vim.keymap.set("n", "<leader>r", function() Snacks.picker.recent() end, { desc = "recent files" })
  end

  -- Replaces <C-t>'s tag-stack pop. Cmd+T from any mode.
  vim.keymap.set("n", "<C-t>", "<Cmd>tabnew<CR>", { desc = "corkboard: new tab" })
  vim.keymap.set({ "n", "i", "t" }, "<D-t>", "<Cmd>tabnew<CR>", { desc = "corkboard: new tab" })
  -- Ctrl+S or Cmd+S writes, where there's a file to, as other editors do.
  vim.keymap.set({ "n", "i" }, "<C-s>", "<Cmd>update<CR>", { desc = "corkboard: write" })
  vim.keymap.set({ "n", "i" }, "<D-s>", "<Cmd>update<CR>", { desc = "corkboard: write" })
  -- Alt+b and f a word back and on, as readline has them (a Mac's
  -- Option+arrows, input.js), which unmapped would leave insert mode. Ctrl,
  -- since Shift with an arrow can select (corkboard.vimkeys).
  vim.keymap.set({ "i", "c" }, "<M-b>", "<C-Left>", { desc = "corkboard: word back" })
  vim.keymap.set({ "i", "c" }, "<M-f>", "<C-Right>", { desc = "corkboard: word on" })
  -- Ctrl+Tab and Ctrl+Shift+Tab, or Ctrl+Shift+j and k (Cmd+Shift+] and [ on
  -- a Mac), go down and up the tabs from any mode, round from the last to the
  -- first; plain Tab stays the program's (completion, Claude Code's mode
  -- cycling).
  for lhs, step in pairs({
    ["<C-Tab>"] = 1, ["<C-S-Tab>"] = -1, ["<C-S-j>"] = 1, ["<C-S-k>"] = -1, ["<D-S-]>"] = 1, ["<D-S-[>"] = -1,
  }) do
    vim.keymap.set({ "n", "i", "t" }, lhs, function() tab_step(step) end, {
      desc = "corkboard: " .. (step > 0 and "next" or "previous") .. " tab",
    })
  end

  -- Alt+1 to 9 (Cmd+1 to 9) go to that tab, as the sidebar numbers them:
  -- projects, the board, usage, the fleet (while it's on), brains, then the agents.
  for i = 1, 9 do
    for _, mod in ipairs({ "A", "D" }) do
      vim.keymap.set({ "n", "i", "t" }, ("<%s-%d>"):format(mod, i), function()
        if i <= vim.fn.tabpagenr("$") then vim.cmd.tabnext(i) end
      end, { desc = "corkboard: tab " .. i })
    end
  end

  -- Alt+h/j/k/l (Cmd+Option+h/j/k/l) moves between the tab's windows, from
  -- insert and terminal mode too, leaving Ctrl+h/j/k/l to Vim and the
  -- terminal's programs. Those and the arrow that goes the same way do the
  -- same.
  local function alt(dir, fn, opts)
    for _, key in ipairs({ dir, require("corkboard.pinned").ARROWS[dir] }) do
      vim.keymap.set({ "n", "i", "t" }, "<A-" .. key .. ">", fn, opts)
      vim.keymap.set({ "n", "i", "t" }, "<D-A-" .. key .. ">", fn, opts)
    end
  end
  -- Left and right go round: the page's list of tabs sits left of the
  -- leftmost window, so from the rightmost (not a float) Alt+l goes there.
  alt("l", function()
    local win = vim.api.nvim_get_current_win()
    vim.cmd.wincmd("l")
    if vim.api.nvim_get_current_win() == win and vim.api.nvim_win_get_config(win).relative == "" then
      M.notify("corkboard.focus_tabs")
    end
  end, { desc = "corkboard: window l, or round to the tabs" })
  -- With no window below or above (and not from a float), Alt+j/k go on
  -- to the next or previous tab.
  for dir, step in pairs({ j = 1, k = -1 }) do
    alt(dir, function()
      local win = vim.api.nvim_get_current_win()
      vim.cmd.wincmd(dir)
      if vim.api.nvim_get_current_win() == win and vim.api.nvim_win_get_config(win).relative == "" then
        tab_step(step)
      end
    end, { desc = "corkboard: window " .. dir .. ", or the " .. (step > 0 and "next" or "previous") .. " tab" })
  end
  -- From the leftmost window (not a float), Alt+h goes on to the page's
  -- list of tabs (corkboard.focus_tabs), where j/k change tab and Alt+j
  -- goes on down to the files.
  alt("h", function()
    local win = vim.api.nvim_get_current_win()
    vim.cmd.wincmd("h")
    if vim.api.nvim_get_current_win() == win and vim.api.nvim_win_get_config(win).relative == "" then
      M.notify("corkboard.focus_tabs")
    end
  end, { desc = "corkboard: window h, or the tabs" })
  -- Alt+q, Ctrl+F4 as Windows closes a document, or Cmd+W.
  for _, lhs in ipairs({ "<A-q>", "<C-F4>", "<D-w>" }) do
    vim.keymap.set({ "n", "i", "t" }, lhs, M.close, { desc = "corkboard: close window or tab" })
  end
  -- Every shortcut above made, the Settings tab can rebind them.
  require("corkboard.settings").keys()
  require("corkboard.vimkeys").changed()

  vim.api.nvim_set_decoration_provider(vim.api.nvim_create_namespace("corkboard.layout"), {
    on_end = M.push_layout,
  })
  local group = vim.api.nvim_create_augroup("corkboard", {})
  vim.api.nvim_create_autocmd("DirChanged", { group = group, callback = board.push })
  vim.api.nvim_create_autocmd("DirChanged", { group = group, callback = function() require("corkboard.projects").changed() end })
  -- Where to reach this Neovim, for Pepper's hand_off (hooks/handoff.lua).
  local function announce()
    local cwd = vim.fn.getcwd(-1, -1)
    require("corkboard.live").set("nvim", { server = require("corkboard.util").server(), window = M.window or "main", cwd = cwd, root = require("corkboard.util").project_root(cwd) })
  end
  announce()
  vim.api.nvim_create_autocmd("DirChanged", { group = group, callback = announce })
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
  -- Any terminal opens the paths clicked in it, from the shell's directory
  -- at the time (a session's own sets it again, from where it started).
  vim.api.nvim_create_autocmd("TermOpen", {
    group = group,
    callback = function(args)
      local pid = vim.b[args.buf].terminal_job_pid
      require("corkboard.session").open_on_click(args.buf, function()
        return pid and vim.uv.fs_readlink(("/proc/%d/cwd"):format(pid)) or vim.fn.getcwd()
      end)
    end,
  })
  -- Entering a terminal is entering terminal mode; <C-\><C-n> leaves it.
  vim.api.nvim_create_autocmd({ "TermOpen", "BufEnter", "WinEnter" }, {
    group = group,
    callback = function(args)
      if vim.bo[args.buf].buftype == "terminal" and vim.api.nvim_get_current_buf() == args.buf then vim.cmd.startinsert() end
    end,
  })
  -- A terminal, or a file in a split, scrolls no further down than its last
  -- line at the bottom, whatever scrolled it (the wheel, Ctrl+E, zt).
  local function clamped(win)
    local buf = vim.api.nvim_win_get_buf(win)
    local bt = vim.bo[buf].buftype
    return bt == "terminal" or bt == "" and not vim.b[buf].corkboard_view and not vim.wo[win].diff
      and vim.api.nvim_win_get_config(win).relative == ""
  end
  -- The highest top line that still has the last line at the bottom: up
  -- from the end, a line as many rows as it wraps to, a closed fold one
  -- row. In the current window.
  local function last_top()
    local height, line, rows, bottom = vim.fn.winheight(0), vim.fn.line("$"), 0, nil
    while line >= 1 do
      local first = vim.fn.foldclosed(line)
      if first == -1 then
        first = line
        rows = rows + vim.api.nvim_win_text_height(0, { start_row = line - 1, end_row = line - 1 }).all
      else
        rows = rows + 1
      end
      if rows > height then break end
      bottom, line = first, first - 1
    end
    return bottom or 1
  end
  -- The wheel stops at the end itself: scrolled past it and put back after,
  -- the page draws the overshoot first and the view snaps back.
  local function wheel_down()
    local pos = vim.fn.getmousepos()
    if pos.winid == 0 or not vim.api.nvim_win_is_valid(pos.winid) then return end
    local steps = tonumber(vim.o.mousescroll:match("ver:(%d+)")) or 3
    vim.api.nvim_win_call(pos.winid, function()
      local stop = clamped(pos.winid) and last_top() or math.huge
      for _ = 1, steps do
        if vim.fn.line("w0") >= stop then break end
        vim.cmd("normal! \5")
      end
    end)
  end
  vim.keymap.set({ "n", "v", "i" }, "<ScrollWheelDown>", wheel_down)
  -- The furthest right that still has the end of the longest line on screen
  -- showing, clear of what the page draws over the window's edge. In the
  -- current window.
  local function last_left(win)
    local longest = 0
    for _, line in ipairs(vim.api.nvim_buf_get_lines(0, vim.fn.line("w0") - 1, vim.fn.line("w$"), false)) do
      longest = math.max(longest, vim.fn.strdisplaywidth(line))
    end
    local text = vim.fn.winwidth(0) - vim.fn.getwininfo(win)[1].textoff - require("corkboard.minimap").covers(win)
    return math.max(0, longest - text)
  end
  -- And across, in any window that doesn't wrap: past the content there is
  -- nothing to see.
  local function wheel_right()
    local pos = vim.fn.getmousepos()
    if pos.winid == 0 or not vim.api.nvim_win_is_valid(pos.winid) then return end
    local steps = tonumber(vim.o.mousescroll:match("hor:(%d+)")) or 6
    vim.api.nvim_win_call(pos.winid, function()
      local n = math.min(steps, last_left(pos.winid) - vim.fn.winsaveview().leftcol)
      if n > 0 then vim.cmd("normal! " .. n .. "zl") end
    end)
  end
  vim.keymap.set({ "n", "v", "i" }, "<ScrollWheelRight>", wheel_right)
  -- Anything else is put back after the event, so the next scroll is
  -- measured from there and fires it again.
  local function clamp(win)
    if not clamped(win) then return end
    vim.api.nvim_win_call(win, function()
      local bottom = last_top()
      if vim.fn.line("w0") > bottom then vim.fn.winrestview({ topline = bottom }) end
    end)
  end
  vim.api.nvim_create_autocmd("WinScrolled", {
    group = group,
    callback = function()
      local wins = vim.tbl_filter(function(id) return id ~= "all" end, vim.tbl_keys(vim.v.event))
      vim.schedule(function()
        for _, id in ipairs(wins) do
          local win = tonumber(id)
          if win and vim.api.nvim_win_is_valid(win) then clamp(win) end
        end
      end)
    end,
  })
  -- A file opened in a window (not one gone back to), for the files panel
  -- to show it.
  vim.api.nvim_create_autocmd("BufWinEnter", {
    group = group,
    callback = function(args)
      if vim.bo[args.buf].buftype ~= "" and not vim.b[args.buf].corkboard_file then return end
      local file = vim.api.nvim_buf_get_name(args.buf)
      if file ~= "" then M.notify("corkboard.opened", file) end
    end,
  })
  -- A save can add a file, so the browser re-reads the folders it shows.
  -- Back from another window, anything may have changed, in folders that
  -- aren't open (and so aren't watched) too.
  vim.api.nvim_create_autocmd({ "BufWritePost", "FocusGained" }, {
    group = group,
    callback = function() M.files_changed() end,
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
      require("corkboard.settings").push_all()
    end,
  })
  status_highlights()
  -- Anything that could have closed or moved a pinned tab: the plan in the
  -- day plan's window, else projects, the board, usage, the fleet and brains, in order, so each finds the
  -- ones before it already in place.
  vim.api.nvim_create_autocmd({ "VimEnter", "TabClosed", "TabNewEntered", "TabEnter", "WinClosed" }, {
    group = group,
    callback = function()
      vim.schedule(function()
        if M.window == "plan" then return plan.ensure() end
        require("corkboard.projects").ensure()
        board.ensure()
        usage.ensure()
        fleet.ensure()
        brains.ensure()
      end)
    end,
  })
end

return M
