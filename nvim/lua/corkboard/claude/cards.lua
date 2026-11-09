-- Cards beside a Claude Code session that has its tab to itself: the ones
-- that session works on, then the open cards ready to be picked up (ready,
-- then backlog; no agent, nothing to wait on). An HTML panel
-- (b:corkboard_view "cards") in a window to the right of the session's, one
-- panel per session. The browser draws it (web/src/views/Cards.tsx). j/k
-- move between cards, t hands the selected one to the session, <CR>
-- opens it in the board's card float (rendered; e there edits it, and its
-- buttons take it, start a session on it, or archive or delete it); s or a click goes to its session, or to what
-- it's asking, or to the card on the board.
--
-- Below it, the lower half of the column, the files agents attached to those
-- cards (attach_file) and the ones the session showed from this machine
-- (the mod's show), newest first: another HTML panel (b:corkboard_view
-- "media", web/src/views/Media.tsx), one line a file, the selected one
-- shown. It opens when there's a file to show, or from the Media tool; a
-- file that arrives opens it and is selected, so it shows as soon as it's sent.
--
-- It opens when the session's window is the only one in its tab (and the
-- page isn't narrow; :AgentCards there puts it underneath), goes with
-- that window, and, closed by hand, stays closed in that tab until
-- :AgentCards. Not beside Pepper, who shares the day plan's tab.

local pinned = require("corkboard.pinned")

local M = {}

-- Blocked first, then working, waiting for review, queued.
local ORDER = { blocked = 1, working = 2, ["needs-review"] = 3, queued = 4 }
local PIN = { blocked = "●", working = "●", ["needs-review"] = "●", queued = "○" }

local cards = {} -- the open cards, as corkboard.board last set them
local panels = {} -- Claude Code terminal buffer -> its panel buffer
local line_card = {} -- panel buffer -> line number -> card id
local selected = {} -- panel buffer -> the card id its cursor is on

-- Its width: a third of the window, no wider than 56 columns.
local function width() return math.min(56, math.floor(vim.o.columns / 3)) end

local function valid_win(win) return win and vim.api.nvim_win_is_valid(win) end

-- A Claude Code session corkboard started that the panel goes beside.
local function is_session(buf)
  local kind = vim.b[buf].corkboard_claude
  return kind ~= nil and kind ~= "pepper" and require("corkboard.terminal").alive(buf)
end

-- The panel's two lists: the cards src's session works on (the card it was
-- started on, or any card whose session it is), blocked first; and the open
-- cards ready to be picked up, ready before backlog.
local function sections(src)
  local agents = require("corkboard.agents")
  local mine, open, index = {}, {}, {}
  for i, c in ipairs(cards) do
    index[c.id] = i
    if c.id == vim.b[src].corkboard_card or agents.session(c.id) == src then
      table.insert(mine, c)
    elseif (c.agent or "") == "" and not c.waiting and (c.status == "ready" or c.status == "backlog") then
      table.insert(open, c)
    end
  end
  table.sort(mine, function(a, b)
    local oa, ob = ORDER[a.agent_state] or 9, ORDER[b.agent_state] or 9
    if oa ~= ob then return oa < ob end
    return index[a.id] < index[b.id]
  end)
  local ready = vim.tbl_filter(function(c) return c.status == "ready" end, open)
  return mine, vim.list_extend(ready, vim.tbl_filter(function(c) return c.status == "backlog" end, open))
end

local function state(src, p)
  local mine, open = sections(src)
  return { mine = mine, open = open, selected = selected[p] }
end

-- The text under the HTML, one line a card.
local function render(src, p)
  local mine, open = sections(src)
  local lines, map = {}, {}
  local function list(title, list, note)
    table.insert(lines, title)
    if #list == 0 then table.insert(lines, "  none") end
    for _, c in ipairs(list) do
      table.insert(lines, string.format("  %s %s  %s  %s", PIN[c.agent_state] or "·", c.id, c.title, note(c)))
      map[#lines] = c.id
    end
    table.insert(lines, "")
  end
  local function join(parts) return table.concat(vim.tbl_filter(function(s) return s ~= "" end, parts), " · ") end
  list("This session's cards", mine, function(c)
    return join({ c.agent_state or c.status, c.priority or "", c.session or "", c.attention or "" })
  end)
  list("Ready to work on", open, function(c) return join({ c.status, c.priority or "" }) end)
  line_card[p] = map
  pinned.set_lines(p, lines)

  -- Keep the cursor on the selected card as cards move.
  if not (selected[p] and pinned.line_of(map, selected[p])) then
    local first = vim.tbl_keys(map)
    table.sort(first)
    selected[p] = map[first[1]]
  end
  pinned.follow(p, map, selected[p])
end

local function notify(src, p) require("corkboard").notify("corkboard.view", p, state(src, p)) end

-- Media -------------------------------------------------------------------------

local media = {} -- Claude Code terminal buffer -> its media panel buffer
local line_file = {} -- media panel buffer -> line number -> file key
local picked = {} -- media panel buffer -> the file key its cursor is on
local newest = {} -- media panel buffer -> the newest file key it has shown
local seen = {} -- Claude Code terminal buffer -> the newest file key on its cards
local shown = {} -- Claude Code terminal buffer -> the files on this machine it showed (M.show_file)

local MIME = {
  png = "image/png",
  jpg = "image/jpeg",
  jpeg = "image/jpeg",
  gif = "image/gif",
  webp = "image/webp",
  avif = "image/avif",
  svg = "image/svg+xml",
  pdf = "application/pdf",
  mp4 = "video/mp4",
  webm = "video/webm",
  mov = "video/quicktime",
  mp3 = "audio/mpeg",
  wav = "audio/wav",
  ogg = "audio/ogg",
  m4a = "audio/mp4",
  json = "application/json",
  html = "text/html",
  csv = "text/csv",
}

local function mime(path)
  local ext = (path:match("%.([^./]+)$") or ""):lower()
  return MIME[ext] or (vim.filetype.match({ filename = path }) and "text/plain") or "application/octet-stream"
end

-- The board's key, for the files' URLs; nil with card files, which have none.
local function board_key()
  local cloud = require("corkboard.cards.cloud")
  if not cloud.enabled() then return nil end
  local ok, k = pcall(cloud.key)
  return ok and k or nil
end

-- What was attached to src's session's cards, and the files it showed,
-- newest first. A card's has the bridge's url (bridge/server.ts's /media);
-- a shown one its path, which the page reads through Neovim.
local function files(src)
  local k, out = board_key(), vim.deepcopy(shown[src] or {})
  for _, c in ipairs(k and (sections(src)) or {}) do
    for _, m in ipairs(type(c.media) == "table" and c.media or {}) do
      table.insert(out, {
        key = c.id .. "/" .. m.id,
        url = ("media/%s/%s/%s"):format(k, c.id, m.id),
        card = c.id,
        name = m.name,
        type = m.type,
        size = m.size,
        at = m.at,
        who = m.who,
      })
    end
  end
  -- Shown in the same second, the later first.
  table.sort(out, function(a, b) return a.at > b.at or (a.at == b.at and (a.n or 0) > (b.n or 0)) end)
  return out
end

local function push_media(src)
  local p = media[src]
  if not (p and vim.api.nvim_buf_is_valid(p)) then return end
  local list = files(src)
  local lines, map = {}, {}
  for _, f in ipairs(list) do
    table.insert(lines, ("%s  %s  %s"):format(f.name, f.type, f.card or ""))
    map[#lines] = f.key
  end
  line_file[p] = map
  pinned.set_lines(p, #lines > 0 and lines or { "" })
  local top = list[1] and list[1].key
  if top ~= newest[p] or not (picked[p] and pinned.line_of(map, picked[p])) then picked[p] = top end
  newest[p] = top
  pinned.follow(p, map, picked[p])
  require("corkboard").notify("corkboard.view", p, { files = list, selected = picked[p] })
end

-- A click on a file in the panel shown in win.
function M.pick(win, key)
  vim.schedule(function()
    if not valid_win(win) then return end
    local p = vim.api.nvim_win_get_buf(win)
    picked[p] = key
    pinned.follow(p, line_file[p] or {}, key)
    push_media(vim.b[p].corkboard_source)
  end)
end

local function media_buf(src)
  local p = media[src]
  if p and vim.api.nvim_buf_is_valid(p) then return p end
  p = vim.api.nvim_create_buf(false, true)
  media[src] = p
  vim.api.nvim_buf_set_name(p, "media://" .. src)
  vim.bo[p].filetype = "corkboard"
  vim.b[p].corkboard_view = "media"
  vim.b[p].corkboard_source = src
  local function step(dir) return function() pinned.step(line_file[p] or {}, dir) end end
  for lhs, key in pairs(pinned.arrows({ j = { step(1), "next file" }, k = { step(-1), "previous file" } })) do
    vim.keymap.set("n", lhs, key[1], { buffer = p, nowait = true, desc = "media: " .. key[2] })
  end
  vim.api.nvim_create_autocmd("CursorMoved", {
    buffer = p,
    callback = function()
      local key = (line_file[p] or {})[vim.api.nvim_win_get_cursor(0)[1]]
      if key and key ~= picked[p] then
        picked[p] = key
        push_media(src)
      end
    end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = src,
    once = true,
    callback = function()
      media[src], line_file[p], picked[p], newest[p] = nil, nil, nil, nil
      vim.schedule(function()
        for _, win in ipairs(vim.fn.win_findbuf(p)) do pcall(vim.api.nvim_win_close, win, true) end
        pcall(vim.api.nvim_buf_delete, p, { force = true })
      end)
    end,
  })
  push_media(src)
  return p
end

local function setup_win(w)
  vim.wo[w][require("corkboard").narrow() and "winfixheight" or "winfixwidth"] = true
  vim.wo[w].number = false
  vim.wo[w].relativenumber = false
  vim.wo[w].signcolumn = "no"
end

-- The media panel under src's cards in pwin, the column's lower half.
local function show_media(src, pwin)
  local tab = vim.api.nvim_win_get_tabpage(pwin)
  local m = media_buf(src)
  for _, w in ipairs(vim.fn.win_findbuf(m)) do
    if vim.api.nvim_win_get_tabpage(w) == tab then return end
  end
  local mwin = vim.api.nvim_open_win(m, false, { split = "below", win = pwin, height = math.floor(vim.api.nvim_win_get_height(pwin) / 2) })
  pinned.follow(m, line_file[m] or {}, picked[m])
  setup_win(mwin)
end

local function push(src, p)
  render(src, p)
  notify(src, p)
  -- A new file opens the media panel under the cards.
  local top = (files(src)[1] or {}).key
  if top and top ~= seen[src] then
    seen[src] = top
    for _, win in ipairs(vim.fn.win_findbuf(p)) do show_media(src, win) end
  end
  push_media(src)
end

-- Its session if it has one running, what it's asking if it asks, else
-- the card on the board.
function M.go(id)
  vim.schedule(function()
    vim.cmd.stopinsert()
    local agents = require("corkboard.agents")
    for _, c in ipairs(cards) do
      if c.id == id and c.attention and c.attention ~= "" then return agents.attend(id) end
    end
    local buf = agents.session(id)
    if buf then return require("corkboard.terminal").focus(buf) end
    require("corkboard.board").reveal(id)
  end)
end

-- A click on a card: what <CR> does, the card in the board's float, with
-- the session's tab left where it is. p: the panel's buffer.
function M.open(id, p)
  vim.schedule(function()
    vim.cmd.stopinsert()
    local src = p and vim.api.nvim_buf_is_valid(p) and vim.b[p].corkboard_source or nil
    require("corkboard.board").open_card(id, { session = src })
  end)
end

local function panel_buf(src)
  local p = panels[src]
  if p and vim.api.nvim_buf_is_valid(p) then return p end
  p = vim.api.nvim_create_buf(false, true)
  panels[src] = p
  vim.api.nvim_buf_set_name(p, "cards://" .. src)
  vim.bo[p].filetype = "corkboard"
  vim.b[p].corkboard_view = "cards"
  vim.b[p].corkboard_source = src
  local function cursor_card() return (line_card[p] or {})[vim.api.nvim_win_get_cursor(0)[1]] end
  local function on_card(fn)
    return function()
      local id = cursor_card()
      if id then fn(id) end
    end
  end
  local function step(dir) return function() pinned.step(line_card[p] or {}, dir) end end
  local keys = {
    j = { step(1), "next card" },
    k = { step(-1), "previous card" },
    ["<CR>"] = { on_card(function(id) require("corkboard.board").open_card(id, { session = src }) end), "open the card" },
    s = { on_card(M.go), "go to the card's session" },
    t = { on_card(function(id) require("corkboard.agents").take(src, id) end), "this session takes the card" },
  }
  for lhs, key in pairs(pinned.arrows(keys)) do
    vim.keymap.set("n", lhs, key[1], { buffer = p, nowait = true, desc = "cards: " .. key[2] })
  end
  vim.api.nvim_create_autocmd("CursorMoved", {
    buffer = p,
    callback = function()
      local id = cursor_card()
      if id and id ~= selected[p] then
        selected[p] = id
        notify(src, p)
      end
    end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = src,
    once = true,
    callback = function()
      panels[src] = nil
      seen[src] = nil
      line_card[p] = nil
      selected[p] = nil
      vim.schedule(function()
        for _, win in ipairs(vim.fn.win_findbuf(p)) do pcall(vim.api.nvim_win_close, win, true) end
        pcall(vim.api.nvim_buf_delete, p, { force = true })
      end)
    end,
  })
  push(src, p)
  return p
end

-- Closed here, not by hand.
local closing = false

local function close(win)
  closing = true
  pcall(vim.api.nvim_win_close, win, true)
  closing = false
end

-- Narrow, the column goes under the session instead, in its lower half.
local function open(win)
  local narrow = require("corkboard").narrow()
  local src = vim.api.nvim_win_get_buf(win)
  local p = panel_buf(src)
  local pwin = narrow
      and vim.api.nvim_open_win(p, false, { split = "below", win = win, height = math.floor(vim.api.nvim_win_get_height(win) / 2) })
    or vim.api.nvim_open_win(p, false, { split = "right", win = win, width = width() })
  pinned.follow(p, line_card[p] or {}, selected[p])
  setup_win(pwin)
  if seen[src] then show_media(src, pwin) end
  local tab = vim.api.nvim_win_get_tabpage(pwin)
  -- Closing the cards closes the column.
  vim.api.nvim_create_autocmd("WinClosed", {
    pattern = tostring(pwin),
    once = true,
    callback = function()
      if not closing and valid_win(win) and vim.api.nvim_tabpage_is_valid(tab) then vim.t[tab].corkboard_cards_off = true end
      local m = media[src]
      vim.schedule(function()
        for _, mwin in ipairs(m and vim.api.nvim_buf_is_valid(m) and vim.fn.win_findbuf(m) or {}) do
          if vim.api.nvim_win_get_tabpage(mwin) == tab then close(mwin) end
        end
      end)
    end,
  })
  return pwin
end

-- The current tab's windows: its sessions', its panels', and the rest.
local function windows()
  local sessions, shown, rest = {}, {}, 0
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(win).relative == "" then
      local buf = vim.api.nvim_win_get_buf(win)
      if vim.b[buf].corkboard_view == "cards" or vim.b[buf].corkboard_view == "media" then
        table.insert(shown, win)
      elseif is_session(buf) then
        table.insert(sessions, win)
      else
        rest = rest + 1
      end
    end
  end
  return sessions, shown, rest
end

-- A panel whose session's window has left the tab goes too; a session alone
-- in its tab gets one, unless the page is narrow.
local function sync()
  local sessions, shown, rest = windows()
  for _, pwin in ipairs(shown) do
    local src = vim.b[vim.api.nvim_win_get_buf(pwin)].corkboard_source
    local here = vim.tbl_filter(function(w) return vim.api.nvim_win_get_buf(w) == src end, sessions)
    if #here == 0 then close(pwin) end
  end
  if #sessions == 1 and rest == 0 and #shown == 0 and not vim.t.corkboard_cards_off and not require("corkboard").narrow() then
    open(sessions[1])
  end
end

local queued = false
local function later()
  if queued then return end
  queued = true
  vim.schedule(function()
    queued = false
    sync()
  end)
end

-- :AgentCards: the panel beside this tab's session, or not.
function M.toggle()
  local sessions, shown = windows()
  if #shown > 0 then
    for _, pwin in ipairs(shown) do close(pwin) end
    vim.t.corkboard_cards_off = true
    return
  end
  if #sessions == 0 then return vim.notify("corkboard: no Claude Code session in this tab") end
  vim.t.corkboard_cards_off = nil
  open(sessions[1])
end

-- The Media tool: the media panel under this tab's session's cards, the
-- cards opened for it if they aren't.
function M.media()
  local sessions, shown = windows()
  for _, w in ipairs(shown) do
    local buf = vim.api.nvim_win_get_buf(w)
    if vim.b[buf].corkboard_view == "cards" then return show_media(vim.b[buf].corkboard_source, w) end
  end
  if #sessions == 0 then return vim.notify("corkboard: no Claude Code session in this tab") end
  vim.t.corkboard_cards_off = nil
  show_media(vim.api.nvim_win_get_buf(sessions[1]), open(sessions[1]))
end

-- The mod's show (claude-plugin/hooks/show.tsx, through hooks/show.lua): a
-- file on this machine in src's media panel, selected, the panel opened
-- under its cards if the session's window is up. Shown again (it changed),
-- it moves to the top. Returns whether it's shown, and what to tell Claude.
local count = 0
function M.show_file(src, path, title)
  if not (vim.api.nvim_buf_is_valid(src) and vim.b[src].corkboard_claude) then return false, "no session in terminal " .. src end
  local stat = vim.uv.fs_stat(path)
  if not (stat and stat.type == "file") then return false, "no file at " .. path end
  if not shown[src] then
    vim.api.nvim_create_autocmd("BufWipeout", { buffer = src, once = true, callback = function() shown[src] = nil end })
  end
  local list = vim.tbl_filter(function(f) return f.path ~= path end, shown[src] or {})
  local mtime = stat.mtime.sec * 1e3 + math.floor(stat.mtime.nsec / 1e6)
  count = count + 1
  table.insert(list, {
    key = ("file:%s@%d"):format(path, mtime),
    path = path,
    mtime = mtime,
    name = type(title) == "string" and title ~= "" and title or vim.fs.basename(path),
    type = mime(path),
    size = stat.size,
    at = os.date("!%Y-%m-%dT%H:%M:%SZ"),
    who = "claude",
    n = count,
  })
  shown[src] = list
  local p = panels[src]
  local up = p and vim.api.nvim_buf_is_valid(p) and vim.fn.win_findbuf(p)[1]
  local win = vim.fn.win_findbuf(src)[1]
  if up then
    push(src, p)
  elseif win then
    vim.t[vim.api.nvim_win_get_tabpage(win)].corkboard_cards_off = nil
    show_media(src, open(win))
  end
  push_media(src)
  return true, (up or win) and "shown in the media panel" or "in the media panel, for when the user opens the session"
end

-- The open cards, in board order, from corkboard.board.
function M.set(list)
  cards = vim.deepcopy(list)
  M.push_all()
end

-- To every panel, and to a page that just attached.
function M.push_all()
  for src, p in pairs(panels) do
    if vim.api.nvim_buf_is_valid(src) and vim.api.nvim_buf_is_valid(p) then push(src, p) end
  end
end

function M.setup()
  local group = vim.api.nvim_create_augroup("corkboard.claude.cards", {})
  vim.api.nvim_create_autocmd({ "TabEnter", "WinEnter", "BufWinEnter", "WinClosed", "TermClose" }, {
    group = group,
    callback = later,
  })
  -- Narrow or wide again: every panel goes, laid out the other way, and the
  -- one in this tab comes back if it should (the others on TabEnter).
  vim.api.nvim_create_autocmd("User", {
    group = group,
    pattern = "CorkboardNarrow",
    callback = function()
      -- Both halves: WinClosed, which takes the lower one with the cards,
      -- doesn't fire inside this autocmd.
      for _, list in ipairs({ panels, media }) do
        for _, p in pairs(list) do
          for _, win in ipairs(vim.api.nvim_buf_is_valid(p) and vim.fn.win_findbuf(p) or {}) do close(win) end
        end
      end
      later()
    end,
  })
  vim.api.nvim_create_autocmd("VimResized", {
    group = group,
    callback = function()
      if require("corkboard").narrow() then return end
      for src, p in pairs(panels) do
        for _, win in ipairs(vim.api.nvim_buf_is_valid(p) and vim.fn.win_findbuf(p) or {}) do
          vim.api.nvim_win_set_width(win, width())
          -- The media panel below it keeps half the column.
          local m = media[src]
          local tab = vim.api.nvim_win_get_tabpage(win)
          for _, mwin in ipairs(m and vim.api.nvim_buf_is_valid(m) and vim.fn.win_findbuf(m) or {}) do
            if vim.api.nvim_win_get_tabpage(mwin) == tab then
              vim.api.nvim_win_set_height(mwin, math.floor((vim.api.nvim_win_get_height(win) + vim.api.nvim_win_get_height(mwin)) / 2))
            end
          end
        end
      end
    end,
  })
  vim.api.nvim_create_user_command("AgentCards", M.toggle, { desc = "corkboard: cards beside Claude Code" })
end

return M
