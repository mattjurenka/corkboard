-- Viewers for files Neovim cannot usefully show as text.
--
-- Images and PDFs: BufReadCmd takes over reading them, so the buffer keeps
-- the file's name (and its place in buffer lists, :e, the file browser) but
-- holds a one-line summary instead of bytes. It is an HTML view
-- (b:corkboard_view "image" or "pdf") and the browser draws the file over
-- it, fetching the bytes with M.read. b:corkboard_file marks it as a file
-- rather than a panel, so files open over it like over any other.
--
-- Markdown: the file stays an ordinary buffer to edit, and a preview window
-- (b:corkboard_view "markdown") opens to its right that the browser renders
-- live, scrolled to match. It follows its source window: another markdown
-- file there swaps it, anything else closes it. :MarkdownPreview toggles it.
--
-- Each view buffer's state goes to the browser as corkboard.view (buf,
-- state); a state without text is a scroll and merges into the last one.

local M = {}

local MIME = {
  png = "image/png",
  jpg = "image/jpeg",
  jpeg = "image/jpeg",
  gif = "image/gif",
  webp = "image/webp",
  avif = "image/avif",
  bmp = "image/bmp",
  ico = "image/x-icon",
  svg = "image/svg+xml",
  pdf = "application/pdf",
}

-- Past this the base64 round trip through RPC gets slow; the view says so
-- instead of trying.
local MAX_BYTES = 64 * 1024 * 1024

local function notify(buf, state)
  require("corkboard").notify("corkboard.view", buf, state)
end

local function mime(path)
  return MIME[(path:match("%.([^./]+)$") or ""):lower()]
end

-- Images and PDFs ---------------------------------------------------------------

local watchers = {} -- buf -> fs_event

local function file_state(buf)
  local path = vim.api.nvim_buf_get_name(buf)
  local stat = vim.uv.fs_stat(path)
  return {
    path = path,
    name = vim.fs.basename(path),
    mime = mime(path),
    size = stat and stat.size,
    mtime = stat and (stat.mtime.sec * 1e3 + math.floor(stat.mtime.nsec / 1e6)),
    error = not stat and "file not found" or (stat.size > MAX_BYTES and "too large to show here") or nil,
  }
end

local function human(bytes)
  if not bytes then return "?" end
  for _, unit in ipairs({ "B", "KB", "MB" }) do
    if bytes < 1024 then return (unit == "B" and "%d %s" or "%.1f %s"):format(bytes, unit) end
    bytes = bytes / 1024
  end
  return ("%.1f GB"):format(bytes)
end

-- An agent regenerating a plot or a PDF shows up without :e. Editors and
-- build tools write in several steps, so settle before re-reading.
local function watch(buf, path)
  if watchers[buf] then watchers[buf]:stop() end
  local w = vim.uv.new_fs_event()
  if not w then return end
  watchers[buf] = w
  local pending = false
  w:start(path, {}, function()
    if pending then return end
    pending = true
    vim.defer_fn(function()
      pending = false
      if vim.api.nvim_buf_is_valid(buf) then notify(buf, file_state(buf)) end
    end, 100)
  end)
end

local function read_file(args)
  local buf = args.buf
  local state = file_state(buf)
  vim.bo[buf].buftype = "nowrite"
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, {
    ("%s  %s  %s"):format(state.name, state.mime, human(state.size)),
  })
  vim.bo[buf].modifiable = false
  vim.bo[buf].modified = false
  vim.b[buf].corkboard_view = state.mime == "application/pdf" and "pdf" or "image"
  vim.b[buf].corkboard_file = true
  notify(buf, state)
  watch(buf, state.path)
end

-- The file's bytes as base64, for the browser to turn into a blob. Also how
-- a markdown preview loads the images it links to, so any readable file.
function M.read(path)
  local stat = vim.uv.fs_stat(path)
  assert(stat and stat.type == "file", "not a file: " .. path)
  assert(stat.size <= MAX_BYTES, "too large: " .. path)
  local f = assert(io.open(path, "rb"))
  local data = f:read("a")
  f:close()
  return { data = vim.base64.encode(data), mime = mime(path) }
end

-- Markdown preview ---------------------------------------------------------------

local previews = {} -- source buf -> preview buf
local timers = {} -- source buf -> debounce timer for text changes

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

-- A card or the board's README is markdown too, but the board tab has no
-- room for a third column and cards are short.
local function previewable(buf)
  if vim.bo[buf].filetype ~= "markdown" or vim.bo[buf].buftype ~= "" then return false end
  local name = vim.api.nvim_buf_get_name(buf)
  return name ~= "" and not name:find("/corkboard/boards/", 1, true)
end

-- The windows in this tab showing src with a preview beside them.
local function source_wins(src)
  return vim.tbl_filter(function(w)
    return vim.api.nvim_win_get_buf(w) == src and valid_win(vim.w[w].corkboard_preview)
  end, vim.api.nvim_tabpage_list_wins(0))
end

local function push_preview(src, with_text)
  local p = previews[src]
  if not (p and vim.api.nvim_buf_is_valid(p) and vim.api.nvim_buf_is_valid(src)) then return end
  local win = source_wins(src)[1]
  local state = { topline = win and vim.fn.line("w0", win) or 1 }
  if with_text then
    state.path = vim.api.nvim_buf_get_name(src)
    state.text = table.concat(vim.api.nvim_buf_get_lines(src, 0, -1, false), "\n")
  end
  notify(p, state)
end

local function preview_buf(src)
  local p = previews[src]
  if p and vim.api.nvim_buf_is_valid(p) then return p end
  p = vim.api.nvim_create_buf(false, true)
  previews[src] = p
  local name = vim.api.nvim_buf_get_name(src)
  vim.api.nvim_buf_set_name(p, "preview://" .. name)
  vim.api.nvim_buf_set_lines(p, 0, -1, false, { "Preview of " .. vim.fn.fnamemodify(name, ":~:.") })
  vim.bo[p].modifiable = false
  vim.b[p].corkboard_view = "markdown"
  vim.b[p].corkboard_source = src

  local group = vim.api.nvim_create_augroup("corkboard.preview." .. src, {})
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufWritePost" }, {
    group = group,
    buffer = src,
    callback = function()
      -- Typing re-renders at most every 80ms.
      if timers[src] then return end
      timers[src] = vim.defer_fn(function()
        timers[src] = nil
        push_preview(src, true)
      end, 80)
    end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    buffer = src,
    callback = function()
      previews[src] = nil
      pcall(vim.api.nvim_del_augroup_by_id, group)
      vim.schedule(function() pcall(vim.api.nvim_buf_delete, p, { force = true }) end)
    end,
  })
  return p
end

local function close_preview(win)
  local pwin = vim.w[win].corkboard_preview
  vim.w[win].corkboard_preview = nil
  if valid_win(pwin) then pcall(vim.api.nvim_win_close, pwin, true) end
end

local function open_preview(win, src)
  local p = preview_buf(src)
  local pwin = vim.w[win].corkboard_preview
  if valid_win(pwin) then
    if vim.api.nvim_win_get_buf(pwin) ~= p then vim.api.nvim_win_set_buf(pwin, p) end
  else
    pwin = vim.api.nvim_open_win(p, false, { split = "right", win = win })
    vim.wo[pwin].number = false
    vim.wo[pwin].relativenumber = false
    vim.wo[pwin].signcolumn = "no"
    vim.w[win].corkboard_preview = pwin
    -- Closed by hand: stays closed for this file in this window until
    -- :MarkdownPreview brings it back.
    vim.api.nvim_create_autocmd("WinClosed", {
      pattern = tostring(pwin),
      once = true,
      callback = function()
        if valid_win(win) and vim.w[win].corkboard_preview == pwin then
          vim.w[win].corkboard_preview = nil
          vim.w[win].corkboard_preview_off = vim.api.nvim_win_get_buf(win)
        end
      end,
    })
  end
  push_preview(src, true)
end

-- Opening the preview window fires the events that call sync, before
-- w:corkboard_preview is set.
local opening = false

-- After the buffer in win changed: a preview for markdown, none otherwise.
local function sync(win)
  if opening or not valid_win(win) or vim.api.nvim_win_get_config(win).relative ~= "" then return end
  local buf = vim.api.nvim_win_get_buf(win)
  if require("corkboard").is_panel(buf) then return end
  if not previewable(buf) or vim.g.corkboard_markdown_preview == false then
    return close_preview(win)
  end
  if vim.w[win].corkboard_preview_off == buf then return end
  vim.w[win].corkboard_preview_off = nil
  -- A split of a window that already has one (or that window, entered
  -- again from elsewhere) needs no second preview.
  if not valid_win(vim.w[win].corkboard_preview) and #source_wins(buf) > 0 then return end
  opening = true
  local ok, err = pcall(open_preview, win, buf)
  opening = false
  if not ok then vim.notify("corkboard: preview: " .. tostring(err), vim.log.levels.ERROR) end
end

-- :MarkdownPreview, for the current window.
function M.toggle()
  local win = vim.api.nvim_get_current_win()
  local buf = vim.api.nvim_get_current_buf()
  if valid_win(vim.w[win].corkboard_preview) then
    close_preview(win)
    vim.w[win].corkboard_preview_off = buf
  elseif previewable(buf) then
    vim.w[win].corkboard_preview_off = nil
    opening = true
    pcall(open_preview, win, buf)
    opening = false
  else
    vim.notify("corkboard: not a markdown file")
  end
end

-- Everything the browser has not seen, for a channel that just attached.
function M.push_all()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(buf) and vim.b[buf].corkboard_file then notify(buf, file_state(buf)) end
  end
  for src in pairs(previews) do push_preview(src, true) end
end

function M.setup()
  local group = vim.api.nvim_create_augroup("corkboard.viewer", {})
  local patterns = {}
  for ext in pairs(MIME) do
    table.insert(patterns, "*." .. ext)
    table.insert(patterns, "*." .. ext:upper())
  end
  vim.api.nvim_create_autocmd("BufReadCmd", { group = group, pattern = patterns, callback = read_file })
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    callback = function(args)
      if watchers[args.buf] then
        watchers[args.buf]:stop()
        watchers[args.buf] = nil
      end
    end,
  })

  vim.api.nvim_create_autocmd({ "BufWinEnter", "BufEnter", "FileType" }, {
    group = group,
    callback = function() sync(vim.api.nvim_get_current_win()) end,
  })
  vim.api.nvim_create_autocmd("WinScrolled", {
    group = group,
    callback = function()
      for id in pairs(vim.v.event) do
        local win = tonumber(id)
        if valid_win(win) and valid_win(vim.w[win].corkboard_preview) then
          push_preview(vim.api.nvim_win_get_buf(win), false)
        end
      end
    end,
  })
  -- The source window gone takes its preview with it.
  vim.api.nvim_create_autocmd("WinClosed", {
    group = group,
    callback = function(args)
      local win = tonumber(args.match)
      local pwin = valid_win(win) and vim.w[win].corkboard_preview
      if valid_win(pwin) then
        vim.schedule(function() pcall(vim.api.nvim_win_close, pwin, true) end)
      end
    end,
  })
  vim.api.nvim_create_user_command("MarkdownPreview", M.toggle, { desc = "corkboard: toggle markdown preview" })
end

return M
