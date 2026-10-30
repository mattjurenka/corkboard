-- The project board, in the agent://board buffer: a plain listing (what a
-- terminal would show) that the browser draws the HTML board over. The
-- selected card is the one whose line the cursor is on.
--
-- Cards are files (corkboard.cards), so agents and the backlog CLI can use
-- them too; a directory watcher picks up every change.

local cards = require("corkboard.cards")
local pinned = require("corkboard.pinned")

local M = {}

M.statuses = cards.statuses
M.get = cards.get
M.dir = cards.dir

local buf
local shown = {} -- the cards on the board, as last read
local costs = {} -- card id -> what its agents cost (corkboard.usage)
local line_card = {} -- line number -> card id
local selected -- card id under the cursor
local last_state -- what the page was last sent, to skip repeats

function M.waiting_on(card) return cards.waiting_on(card, shown) end

-- Writes, each followed by a push so the board shows it at once.

function M.set(id, fields)
  cards.set(id, fields)
  M.push()
end

function M.log(id, who, note)
  cards.log(id, who, note)
  M.push()
end

function M.create(title, status, body)
  local id = cards.create(title, status, body)
  M.push()
  return id
end

-- Hand the card to an agent: queued; corkboard.agents starts it when it may.
function M.assign(id, agent)
  M.set(id, { agent = agent or "claude", agent_state = "queued", status = "ready", attention = "" })
end

-- "-- TODO(me): fix this" -> "fix this". Block-comment closers are dropped.
local function todo_text(line)
  for _, marker in ipairs({ "TODO", "FIXME", "XXX", "HACK" }) do
    local text = line:match("%f[%w]" .. marker .. "%f[%W]%s*%b()%s*:?%s*(.*)$")
      or line:match("%f[%w]" .. marker .. "%f[%W]%s*:?%s*(.*)$")
    if text then
      text = vim.trim(text:gsub("%s*%*/%s*$", ""):gsub("%s*%-%->%s*$", ""))
      if text ~= "" then return text end
    end
  end
end

-- :AgentCard, <leader>c: a card describing lines first..last of the current
-- buffer, under their path:line. The title is asked for, prefilled from a
-- TODO comment on the first line.
function M.card_from_code(first, last)
  local b = vim.api.nvim_get_current_buf()
  local lines = vim.api.nvim_buf_get_lines(b, first - 1, last, false)
  local name = vim.api.nvim_buf_get_name(b)
  local where = (name ~= "" and vim.fn.fnamemodify(name, ":.") or "[No Name]")
    .. ":" .. first .. (last > first and ("-" .. last) or "")
  local indent = math.huge
  for _, l in ipairs(lines) do
    if l:match("%S") then indent = math.min(indent, #l:match("^%s*")) end
  end
  if indent == math.huge then indent = 0 end
  local code = table.concat(vim.tbl_map(function(l) return l:sub(indent + 1) end, lines), "\n")
  local body = string.format("`%s`\n\n```%s\n%s\n```", where, vim.bo[b].filetype, code)
  local default = todo_text(lines[1] or "") or (last == first and vim.trim(lines[1] or "") or "")
  vim.ui.input({ prompt = "New card from " .. where .. ": ", default = default }, function(title)
    if not (title and vim.trim(title) ~= "") then return end
    local id = M.create(vim.trim(title), "backlog", body)
    vim.notify("corkboard: " .. id .. " " .. vim.trim(title))
  end)
end

-- State ---------------------------------------------------------------------------

local function column(status)
  return vim.tbl_filter(function(c) return c.status == status end, shown)
end

local function waiting_text(waiting)
  return table.concat(vim.tbl_map(function(w) return w.id .. (w.missing and " (no such card)" or "") end, waiting), ", ")
end

-- The newest log entries across every card, newest first. Entries are
-- `- <ISO time> <name>: <note>` with indented continuation lines; anything
-- else in the notes is skipped.
local max_activity = 100

local function activity()
  local entries = {}
  for _, c in ipairs(shown) do
    local entry
    for line in vim.gsplit(cards.section(c, "NOTES"), "\n", { plain = true }) do
      local time, agent, text = line:match("^%- (%d%d%d%d%-%d%d%-%d%dT[%d:]+Z) ([^:]+): (.*)$")
      if time then
        entry = { time = time, agent = agent, id = c.id, title = c.title, text = text, seq = #entries }
        table.insert(entries, entry)
      elseif entry and line:match("^  ") then
        entry.text = entry.text .. "\n" .. line:sub(3)
      else
        entry = nil
      end
    end
  end
  -- UTC ISO times sort as strings; within a second, the later-written wins.
  table.sort(entries, function(a, b)
    if a.time ~= b.time then return a.time > b.time end
    return a.seq > b.seq
  end)
  return vim.list_slice(entries, 1, max_activity)
end

local function state()
  local agents = require("corkboard.agents")
  return {
    root = require("corkboard.util").project_root(),
    statuses = M.statuses,
    selected = selected,
    activity = activity(),
    cards = vim.tbl_map(function(c)
      return {
        id = c.id,
        title = c.title,
        status = c.status,
        priority = c.priority,
        agent = c.agent,
        agent_state = c.agent_state,
        attention = c.attention,
        waiting = M.waiting_on(c),
        session = agents.live(c.id),
        cost = costs[c.id],
      }
    end, shown),
  }
end

local function push_state()
  local s = state()
  local key = vim.json.encode(s)
  if key == last_state then return end
  last_state = key
  require("corkboard").notify("corkboard.board", s)
  -- The open cards, in board order, for the panels beside the Claude Code
  -- sessions (corkboard.claude.cards).
  require("corkboard.claude.cards").set(vim.tbl_map(function(c)
    return {
      id = c.id,
      title = c.title,
      status = c.status,
      priority = c.priority,
      agent = c.agent,
      agent_state = c.agent_state,
      attention = c.attention,
      session = c.session,
      waiting = c.waiting,
      cost = c.cost,
    }
  end, vim.tbl_filter(function(c) return c.status ~= "done" end, s.cards)))
end

local function render_text()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local agents = require("corkboard.agents")
  local lines, map = { "Board  " .. vim.fn.getcwd(), "" }, {}
  for _, status in ipairs(M.statuses) do
    local col = column(status)
    table.insert(lines, string.format("%s (%d)", status:upper(), #col))
    for _, c in ipairs(col) do
      local who = ""
      if c.agent or c.agent_state then
        local session = agents.live(c.id)
        who = "  [" .. (c.agent or "agent") .. (c.agent_state and (" · " .. c.agent_state) or "")
          .. (session and (" · session " .. session) or "") .. "]"
      end
      local priority = c.priority and ("(" .. c.priority .. ") ") or ""
      table.insert(lines, "  " .. priority .. c.title .. who .. (c.attention and ("  ! " .. c.attention) or ""))
      map[#lines] = c.id
      local waiting = M.waiting_on(c)
      if waiting then table.insert(lines, "  └─ waits on " .. waiting_text(waiting)) end
    end
    if #col == 0 then table.insert(lines, "  —") end
    table.insert(lines, "")
  end
  pinned.set_lines(buf, lines)
  line_card = map

  -- Keep the cursor on the selected card as cards move.
  if not (selected and pinned.line_of(line_card, selected)) then
    local first = vim.tbl_keys(line_card)
    table.sort(first)
    selected = line_card[first[1]]
  end
  pinned.follow(buf, line_card, selected)
end

-- Navigation ----------------------------------------------------------------------

local function cursor_card() return line_card[vim.api.nvim_win_get_cursor(0)[1]] end

local function goto_card(id)
  local lnum = id and pinned.line_of(line_card, id)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
end

-- h/l: the same position in the nearest non-empty column that way.
function M.jump(dir)
  local id = cursor_card()
  local card = id and vim.iter(shown):find(function(c) return c.id == id end)
  local from = card and vim.fn.index(M.statuses, card.status) + 1 or 1
  local index = 1
  if card then
    for i, c in ipairs(column(card.status)) do
      if c.id == id then index = i end
    end
  end
  for s = from + dir, dir > 0 and #M.statuses or 1, dir do
    local col = column(M.statuses[s])
    if #col > 0 then return goto_card(col[math.min(index, #col)].id) end
  end
end

-- The card float ----------------------------------------------------------------
--
-- A card opens in a float over the board, reused for the next one. It opens
-- rendered: a markdown view (b:corkboard_view "markdown") the browser draws
-- over the same text, kept up with the card file. e edits it in place (or
-- straight from the board): the title is the first line, as a heading, and
-- the description the rest; :w writes them into the card file. q closes it,
-- saving edits; rendered, so do <CR> and <Esc>.

local card_win
local rendered -- the rendered float: { buf, id }

local function save_card(id, lines)
  local title = vim.trim((lines[1] or ""):gsub("^#+%s*", ""))
  cards.change(id, function(card)
    cards.set_description(card, table.concat(vim.list_slice(lines, 2), "\n"))
    if title ~= "" then card.title = title end
  end)
  M.push()
end

local function card_lines(card)
  local lines = { "# " .. card.title, "" }
  vim.list_extend(lines, vim.split(cards.section(card, "DESCRIPTION"), "\n", { plain = true }))
  return lines
end

local function card_buffer(id)
  local b = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(b, "agent://card/" .. id)
  vim.bo[b].buftype = "acwrite"
  vim.bo[b].bufhidden = "wipe"
  vim.bo[b].filetype = "markdown"
  vim.api.nvim_buf_set_lines(b, 0, -1, false, card_lines(cards.get(id)))
  vim.bo[b].modified = false
  vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = b,
    callback = function()
      save_card(id, vim.api.nvim_buf_get_lines(b, 0, -1, false))
      vim.bo[b].modified = false
    end,
  })
  vim.keymap.set("n", "q", "<Cmd>update | close<CR>", { buffer = b, nowait = true, desc = "board: save and close card" })
  return b
end

-- The rendered card, as the card file now has it.
local function push_rendered()
  if not (rendered and vim.api.nvim_buf_is_valid(rendered.buf)) then return end
  local card = cards.get(rendered.id)
  if not card then return end
  local lines = card_lines(card)
  vim.bo[rendered.buf].modifiable = true
  vim.api.nvim_buf_set_lines(rendered.buf, 0, -1, false, lines)
  vim.bo[rendered.buf].modifiable = false
  -- A cloud card has no file; its links and images resolve from the project.
  local path = card.path or vim.fs.joinpath(vim.fn.getcwd(), rendered.id .. ".md")
  require("corkboard").notify("corkboard.view", rendered.buf, { path = path, text = table.concat(lines, "\n") })
end

local function rendered_buffer(id)
  local b = vim.api.nvim_create_buf(false, true)
  vim.bo[b].bufhidden = "wipe"
  vim.b[b].corkboard_view = "markdown"
  rendered = { buf = b, id = id }
  for _, lhs in ipairs({ "q", "<CR>", "<Esc>" }) do
    vim.keymap.set("n", lhs, "<Cmd>close<CR>", { buffer = b, nowait = true, desc = "board: close card" })
  end
  vim.keymap.set("n", "e", function() M.open_card(id, { edit = true }) end, { buffer = b, nowait = true, desc = "board: edit card" })
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = b,
    once = true,
    callback = function()
      if rendered and rendered.buf == b then rendered = nil end
    end,
  })
  push_rendered()
  return b
end

local function card_float()
  local width = math.min(80, vim.o.columns - 8)
  local height = math.min(math.max(10, math.floor(vim.o.lines * 0.6)), vim.o.lines - 6)
  return {
    relative = "editor",
    width = width,
    height = height,
    col = math.floor((vim.o.columns - width) / 2) - 1,
    row = math.floor((vim.o.lines - height) / 2) - 1,
    border = "rounded",
  }
end

-- Rendered to read; opts.edit to edit.
function M.open_card(id, opts)
  -- Opening a card is seeing what its agent asked for.
  if cards.get(id).attention then M.set(id, { attention = "" }) end
  local b = (opts and opts.edit and card_buffer or rendered_buffer)(id)
  local title = { title = " " .. id .. " ", title_pos = "center" }

  -- A float left open in another tab is closed, not gone to: the card opens
  -- in this tab.
  if card_win and vim.api.nvim_win_is_valid(card_win) and vim.api.nvim_win_get_tabpage(card_win) ~= vim.api.nvim_get_current_tabpage() then
    vim.api.nvim_win_call(card_win, function() vim.cmd("silent update") end)
    vim.api.nvim_win_close(card_win, true)
  end
  if card_win and vim.api.nvim_win_is_valid(card_win) then
    -- Save the card being replaced rather than drop its edits.
    vim.api.nvim_win_call(card_win, function() vim.cmd("silent update") end)
    vim.api.nvim_win_set_buf(card_win, b)
    vim.api.nvim_win_set_config(card_win, title)
    vim.api.nvim_set_current_win(card_win)
  else
    card_win = vim.api.nvim_open_win(b, true, vim.tbl_extend("error", card_float(), title))
    vim.wo[card_win].wrap = true
    vim.wo[card_win].linebreak = true
    local win = card_win
    local group = vim.api.nvim_create_augroup("corkboard.board.card" .. win, {})
    vim.api.nvim_create_autocmd("WinClosed", {
      group = group,
      pattern = tostring(win),
      once = true,
      callback = function()
        if card_win == win then card_win = nil end
        vim.api.nvim_del_augroup_by_id(group)
      end,
    })
    -- Focus going elsewhere (a click off it, another window) closes it,
    -- saving edits.
    vim.api.nvim_create_autocmd("WinLeave", {
      group = group,
      callback = function()
        if vim.api.nvim_get_current_win() ~= win then return end
        vim.schedule(function()
          if not vim.api.nvim_win_is_valid(win) or vim.api.nvim_get_current_win() == win then return end
          vim.api.nvim_win_call(win, function() vim.cmd("silent! update") end)
          pcall(vim.api.nvim_win_close, win, true)
        end)
      end,
    })
  end
  vim.api.nvim_win_set_cursor(card_win, { 1, 2 })
end

-- Actions -------------------------------------------------------------------------

local function move(id, by)
  local status = id and M.statuses[vim.fn.index(M.statuses, cards.get(id).status) + 1 + by]
  if status then M.set(id, { status = status }) end
end

-- Archive or delete the card, and close its float if it's showing.
local function remove(id, op)
  local ok, err = pcall(cards[op], id)
  if not ok then return vim.notify(tostring(err), vim.log.levels.ERROR) end
  if rendered and rendered.id == id and card_win and vim.api.nvim_win_is_valid(card_win) then
    pcall(vim.api.nvim_win_close, card_win, true)
  end
  vim.notify("corkboard: " .. (op == "archive" and "archived " or "deleted ") .. id)
  M.push()
end

-- On the card under the cursor; also what the HTML buttons call.
local actions = {
  left = function(id) move(id, -1) end,
  right = function(id) move(id, 1) end,
  new = function(id)
    local status = id and cards.get(id).status or "backlog"
    vim.ui.input({ prompt = "New card (" .. status .. "): " }, function(title)
      if title and vim.trim(title) ~= "" then
        selected = M.create(vim.trim(title), status)
        render_text()
        push_state()
      end
    end)
  end,
  assign = function(id)
    if id then M.assign(id) end
  end,
  -- None clears it, which counts as medium.
  priority = function(id)
    if not id then return end
    local choices = vim.list_extend(vim.deepcopy(cards.priorities), { "none" })
    vim.ui.select(choices, { prompt = "Priority of " .. id .. ": " }, function(choice)
      if choice then M.set(id, { priority = choice == "none" and "" or choice }) end
    end)
  end,
  session = function(id)
    local b = id and require("corkboard.agents").session(id)
    if b then return require("corkboard.terminal").focus(b) end
    if id then vim.notify("corkboard: " .. id .. " has no agent running") end
  end,
  review = function(id)
    if id then require("corkboard.review").open(id) end
  end,
  answer = function(id)
    if id then require("corkboard.agents").attend(id) end
  end,
  archive = function(id)
    if id then remove(id, "archive") end
  end,
  -- For good, so it asks first.
  delete = function(id)
    if not id then return end
    vim.ui.select({ "Delete", "Keep" }, { prompt = "Delete " .. id .. " and its log for good? " }, function(choice)
      if choice == "Delete" then remove(id, "delete") end
    end)
  end,
  open = function(id)
    if id then M.open_card(id) end
  end,
  edit = function(id)
    if id then M.open_card(id, { edit = true }) end
  end,
  refresh = function() M.push() end,
}

-- win is set when the browser calls this for a click inside a board window.
function M.action(name, win)
  if not win then return actions[name](cursor_card()) end
  -- From the browser this runs inside an RPC request, which "new"'s prompt
  -- must not block.
  vim.schedule(function()
    if vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
    actions[name](cursor_card())
  end)
end

-- A click on a card in the browser.
function M.select(id, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  goto_card(id)
end

-- The board, a card selected and opened: where a notification or an
-- activity entry leads.
function M.reveal(id)
  M.show()
  M.select(id)
  M.open_card(id)
end

-- The board tab -------------------------------------------------------------------

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  local function act(name) return function() M.action(name) end end
  buf = pinned.listing("agent://board", "board", {
    j = { function() pinned.step(line_card, 1) end, "next card" },
    k = { function() pinned.step(line_card, -1) end, "previous card" },

    h = { function() M.jump(-1) end, "column left" },
    l = { function() M.jump(1) end, "column right" },
    H = { act("left"), "move card left" },
    L = { act("right"), "move card right" },
    o = { act("new"), "new card" },
    a = { act("assign"), "hand to agent" },
    p = { act("priority"), "set the card's priority" },
    s = { act("session"), "go to the agent's session" },
    v = { act("review"), "review the card's work" },
    r = { act("answer"), "go to what the agent is asking" },
    ["<CR>"] = { act("open"), "open card" },
    e = { act("edit"), "edit card" },
    x = { act("archive"), "archive card" },
    D = { act("delete"), "delete card" },
    R = { act("refresh"), "refresh" },
  }, function() return line_card end, function(id)
    if id == selected then return end
    selected = id
    push_state()
  end)
  return buf
end

-- Keep the board first among the tabs. Leaves focus where it was.
function M.ensure()
  if pinned.ensure("corkboard_board", 1, buffer()) then M.push() end
end

function M.show()
  M.ensure()
  pinned.show("corkboard_board", 1, buffer())
end

-- Watching and pushing --------------------------------------------------------------

local watcher, watched, following
-- The last error reading the cards, so a failing board says it once.
local last_error

local function watch()
  -- A cloud board says when it changes; there are no files to watch.
  if cards.cloud() then
    if not following then cards.on_change(function() M.push() end) end
    following = true
    return
  end
  local tasks = cards.tasks_dir()
  if watched == tasks then return end
  if watcher then watcher:stop() end
  watcher, watched = nil, nil
  if vim.fn.isdirectory(tasks) == 0 then return end
  watcher = assert(vim.uv.new_fs_event())
  watched = tasks
  local pending = false
  watcher:start(tasks, {}, function()
    -- Editors write in several steps; settle before re-reading.
    if pending then return end
    pending = true
    vim.defer_fn(function()
      pending = false
      M.push()
    end, 50)
  end)
end

-- Re-read the cards and what they cost, redraw, send the page anything new,
-- and start the agents that may now run.
function M.push()
  -- The day plan's window has no board.
  if require("corkboard").window == "plan" then return end
  watch()
  -- A cloud board can fail to read (signed out, offline). That leaves the
  -- board as it was, not the page's attach and the editor's restore undone.
  local ok, list = pcall(cards.list)
  if not ok then
    if list ~= last_error then vim.notify(tostring(list), vim.log.levels.ERROR) end
    last_error = list
    return
  end
  last_error, shown = nil, list
  costs = require("corkboard.usage").card_costs()
  render_text()
  push_state()
  push_rendered()
  require("corkboard.agents").schedule(shown)
  require("corkboard.agents").finished(shown)
  require("corkboard.budget").check(shown, costs)
end

-- For what isn't in the files, like a session's live state.
function M.redraw()
  costs = require("corkboard.usage").card_costs()
  render_text()
  push_state()
end

-- For a channel that just attached, which has seen nothing.
function M.push_all()
  last_state = nil
  M.push()
  push_rendered()
end

return M
