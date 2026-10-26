-- Cards beside a Claude Code session that has its tab to itself: the ones
-- that session works on, then the open cards ready to be picked up (ready,
-- then backlog; no agent, nothing to wait on). An HTML panel
-- (b:corkboard_view "cards") in a window to the right of the session's, one
-- panel per session. The browser draws it (web/src/views/Cards.tsx). j/k
-- move between cards, <CR>
-- opens the selected one in the board's card float (rendered; e there edits
-- it); s or a click goes to its session, or to what it's asking, or to the
-- card on the board.
--
-- It opens when the session's window is the only one in its tab, goes with
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

local function push(src, p)
  render(src, p)
  notify(src, p)
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
-- the session's tab left where it is.
function M.open(id)
  vim.schedule(function()
    vim.cmd.stopinsert()
    require("corkboard.board").open_card(id)
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
    ["<Down>"] = { step(1), "next card" },
    ["<Up>"] = { step(-1), "previous card" },
    ["<CR>"] = { on_card(function(id) require("corkboard.board").open_card(id) end), "open the card" },
    s = { on_card(M.go), "go to the card's session" },
  }
  for lhs, key in pairs(keys) do
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

local function open(win)
  local src = vim.api.nvim_win_get_buf(win)
  local p = panel_buf(src)
  local pwin = vim.api.nvim_open_win(p, false, { split = "right", win = win, width = width() })
  pinned.follow(p, line_card[p] or {}, selected[p])
  vim.wo[pwin].winfixwidth = true
  vim.wo[pwin].number = false
  vim.wo[pwin].relativenumber = false
  vim.wo[pwin].signcolumn = "no"
  local tab = vim.api.nvim_win_get_tabpage(pwin)
  vim.api.nvim_create_autocmd("WinClosed", {
    pattern = tostring(pwin),
    once = true,
    callback = function()
      if not closing and valid_win(win) and vim.api.nvim_tabpage_is_valid(tab) then vim.t[tab].corkboard_cards_off = true end
    end,
  })
end

-- The current tab's windows: its sessions', its panels', and the rest.
local function windows()
  local sessions, shown, rest = {}, {}, 0
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(win).relative == "" then
      local buf = vim.api.nvim_win_get_buf(win)
      if vim.b[buf].corkboard_view == "cards" then
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
-- in its tab gets one.
local function sync()
  local sessions, shown, rest = windows()
  for _, pwin in ipairs(shown) do
    local src = vim.b[vim.api.nvim_win_get_buf(pwin)].corkboard_source
    local here = vim.tbl_filter(function(w) return vim.api.nvim_win_get_buf(w) == src end, sessions)
    if #here == 0 then close(pwin) end
  end
  if #sessions == 1 and rest == 0 and #shown == 0 and not vim.t.corkboard_cards_off then open(sessions[1]) end
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
  vim.api.nvim_create_autocmd("VimResized", {
    group = group,
    callback = function()
      for _, p in pairs(panels) do
        for _, win in ipairs(vim.api.nvim_buf_is_valid(p) and vim.fn.win_findbuf(p) or {}) do
          vim.api.nvim_win_set_width(win, width())
        end
      end
    end,
  })
  vim.api.nvim_create_user_command("AgentCards", M.toggle, { desc = "corkboard: cards beside Claude Code" })
end

return M
