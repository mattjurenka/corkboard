-- The project board: a Backlog.md board (https://github.com/MrLesk/Backlog.md)
-- in a directory per project under ~/.local/share/corkboard/boards/ (see
-- dir()). One markdown file per card in tasks/, statuses in config.yml:
--
-- ---
-- id: TASK-6
-- title: Render ext_cmdline as HTML
-- status: doing
-- assignee:
--   - claude
-- agent_state: working
-- ---
-- ## Description / ## Implementation Notes, each between SECTION markers;
-- agents append progress to the notes.
--
-- Cards are plain files so agents can read and move them with ordinary
-- edits, and so the backlog CLI can read the same board. A directory watcher
-- pushes every change to the browser.
--
-- The board shows in the agent://board buffer. Its text is a plain listing
-- (what you see in a terminal); the browser draws the HTML board over it.
-- The selected card is whichever card the cursor's line belongs to.

local M = {}

M.statuses = { "backlog", "ready", "doing", "review", "done" }
M.agent_states = { "queued", "working", "blocked", "needs-review", "done" }

-- Backlog.md's keys in the order it writes them, then corkboard's own.
local KEY_ORDER = {
  "id", "title", "status", "assignee", "created_date", "updated_date",
  "labels", "dependencies", "ordinal", "agent_state", "attention",
}
local LISTS = { assignee = true, labels = true, dependencies = true }

local README = [[
# Board

A Backlog.md board (https://github.com/MrLesk/Backlog.md): one card per file
in tasks/, statuses in config.yml. corkboard shows it as a board and updates
live when a file changes; the backlog CLI can read it too.

Front matter is YAML:

- `id`: TASK-<n>; the file is tasks/task-<n> - <Title>.md.
- `title`: one line.
- `status`: backlog | ready | doing | review | done
- `assignee`: a list; its first entry is the agent working on the card. Empty
  when nobody is.
- `created_date`, `updated_date`: 'yyyy-mm-dd hh:mm'.
- `labels`, `dependencies`: lists; dependencies are card ids.
- `ordinal`: optional number; lower sorts first within a column.
- `agent_state` (corkboard): queued | working | blocked | needs-review | done
- `attention` (corkboard): what the agent needs the user to do, one line;
  corkboard sends a desktop notification when it is set, and clears it when
  the user opens the card.

The body is `## Description` and `## Implementation Notes`, each with its text
between `<!-- SECTION:DESCRIPTION:BEGIN -->` / `END` (and `SECTION:NOTES`)
markers. Keep text inside the markers.

If you are an agent working on a card, use the corkboard MCP tools if you
have them (`bun mcp/board.ts` in the corkboard repo); they do the following
for you. Otherwise edit the files by hand:

- When you start, set `status: doing`, `assignee: [<your name>]`, `agent_state: working`.
- If you need a human decision, set `agent_state: blocked` and say what you
  need as the last entry in the notes.
- When you finish, set `status: review`, `agent_state: needs-review`, and note
  what changed and how you verified it.
- Append to the notes, inside their markers, as `- <ISO time> <name>: <note>`;
  never rewrite earlier entries.
- You may create cards for follow-up work you discover; put them in `backlog`.
]]

-- Front matter --------------------------------------------------------------
--
-- The part of YAML that Backlog.md writes: scalars, plain or quoted, and
-- lists, flow ([a, b]) or block ("  - a" lines under "key:").

local function scalar(s)
  s = vim.trim(s)
  local q = s:match("^'(.*)'$")
  if q then return (q:gsub("''", "'")) end
  q = s:match('^"(.*)"$')
  if q then
    return (q:gsub("\\(.)", function(c) return ({ n = "\n", t = "\t" })[c] or c end))
  end
  return s
end

local function flow(s)
  local items, item, quote = {}, "", nil
  for ch in s:match("^%[(.*)%]$"):gmatch(".") do
    if quote then
      if ch == quote then quote = nil end
      item = item .. ch
    elseif ch == "'" or ch == '"' then
      quote = ch
      item = item .. ch
    elseif ch == "," then
      table.insert(items, scalar(item))
      item = ""
    else
      item = item .. ch
    end
  end
  if vim.trim(item) ~= "" then table.insert(items, scalar(item)) end
  return items
end

local function read_front(text)
  local fields, key = {}, nil
  for line in text:gmatch("[^\n]+") do
    local item = line:match("^%s*%-%s+(.*)$") or line:match("^%s*%-$") and ""
    if item and key and type(fields[key]) == "table" then
      table.insert(fields[key], scalar(item))
    else
      local k, v = line:match("^([%w_]+):%s*(.-)%s*$")
      if k then
        key = k
        -- A bare "key:" starts a block list, or is an empty value.
        fields[k] = (v == "" and {}) or (v:match("^%[.*%]$") and flow(v)) or scalar(v)
      end
    end
  end
  for k, v in pairs(fields) do
    if LISTS[k] and type(v) ~= "table" then fields[k] = { v } end
    if not LISTS[k] and type(v) == "table" then fields[k] = v[1] end
  end
  return fields
end

-- Quote a string whenever YAML could read it as something else (a number,
-- date, boolean, list or mapping), the way Backlog.md's dates are quoted.
local function quote(v)
  local plain = v ~= ""
    and not v:match("^[%s%-?:,%[%]{}#&*!|>'\"%%@`]")
    and not v:match("[%s:]$")
    and not v:find(": ", 1, true)
    and not v:find(" #", 1, true)
    and not v:match("^[%d%s.:+%-]+$")
    and not vim.tbl_contains({ "true", "false", "null", "yes", "no", "on", "off", "~" }, v:lower())
  return plain and v or "'" .. v:gsub("'", "''") .. "'"
end

-- Card files ----------------------------------------------------------------

-- A project's board lives outside it, so the cards stay out of its git
-- history: $XDG_DATA_HOME/corkboard/boards/<project path with / as ->,
-- e.g. ~/.local/share/corkboard/boards/home-matthew-agent-ide.
local boards = vim.fs.joinpath(
  vim.env.XDG_DATA_HOME or vim.fs.joinpath(vim.uv.os_homedir(), ".local/share"),
  "corkboard",
  "boards"
)
local resolved = {} -- cwd -> board dir, once its migration has been checked

local function now(time) return os.date("%Y-%m-%d %H:%M", time) end

-- The id's number: TASK-12 -> 12.
local function number(id) return tonumber(tostring(id):match("(%d+)$")) or math.huge end

local function filename(id, title)
  local slug = title:gsub("[^%w]+", "-"):sub(1, 60):gsub("^%-+", ""):gsub("%-+$", "")
  return string.format("%s - %s.md", id:lower(), slug ~= "" and slug or "card")
end

local function section(heading, name, text)
  text = vim.trim(text or "")
  return string.format(
    "## %s\n\n<!-- SECTION:%s:BEGIN -->\n%s<!-- SECTION:%s:END -->\n",
    heading, name, text ~= "" and text .. "\n" or "", name
  )
end

local function sections(description, notes)
  return "\n" .. section("Description", "DESCRIPTION", description) .. "\n" .. section("Implementation Notes", "NOTES", notes)
end

local function parse(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local text = f:read("a")
  f:close()

  local front, body = text:match("^%-%-%-\n(.-)\n%-%-%-\n?(.*)$")
  local card = read_front(front or "")
  card.path, card.body = path, body or text
  local base = vim.fs.basename(path):gsub("%.md$", "")
  card.id = card.id or (base:match("^(%a+%-%d+) %- ") or base):upper()
  card.title = (card.title ~= nil and card.title ~= "") and card.title or card.id
  if not vim.tbl_contains(M.statuses, card.status) then card.status = "backlog" end
  -- corkboard works with one agent per card: the first assignee.
  if card.assignee then card.agent = card.assignee[1] and card.assignee[1]:gsub("^@", "") end
  return card
end

local function serialize(card)
  local lines, seen = { "---" }, { path = true, body = true, agent = true }
  local fields = setmetatable({}, { __index = card })
  fields.assignee = vim.list_slice(card.assignee or {}, 2)
  if card.agent then table.insert(fields.assignee, 1, card.agent) end
  local function emit(k)
    local v = fields[k]
    seen[k] = true
    if type(v) == "table" then
      if #v == 0 then
        table.insert(lines, k .. ": []")
      else
        table.insert(lines, k .. ":")
        for _, item in ipairs(v) do table.insert(lines, "  - " .. quote(tostring(item))) end
      end
    elseif v ~= nil and v ~= "" then
      table.insert(lines, k .. ": " .. ((k == "ordinal" and tonumber(v)) and tostring(v) or quote(tostring(v))))
    end
  end
  for _, k in ipairs(KEY_ORDER) do emit(k) end
  local rest = vim.tbl_filter(function(k) return not seen[k] end, vim.tbl_keys(card))
  table.sort(rest)
  for _, k in ipairs(rest) do emit(k) end
  table.insert(lines, "---")
  return table.concat(lines, "\n") .. "\n" .. (card.body or "")
end

local function write(card)
  local f = assert(io.open(card.path, "w"))
  f:write(serialize(card))
  f:close()
end

-- tasks/, config.yml (the statuses, for the backlog CLI) and the README.
local function setup(board)
  vim.fn.mkdir(vim.fs.joinpath(board, "tasks"), "p")
  local files = {
    ["README.md"] = README,
    ["config.yml"] = table.concat({
      "project_name: " .. quote(vim.fs.basename(vim.fn.getcwd())),
      "default_status: " .. M.statuses[1],
      "statuses: [" .. table.concat(M.statuses, ", ") .. "]",
      "labels: []",
      "date_format: yyyy-mm-dd hh:mm",
      "task_prefix: task",
      "",
    }, "\n"),
  }
  for name, text in pairs(files) do
    local path = vim.fs.joinpath(board, name)
    if vim.fn.filereadable(path) == 0 then
      local f = assert(io.open(path, "w"))
      f:write(text)
      f:close()
    end
  end
end

-- Cards used to be NNN-slug.md files at the top of the board, with flat
-- key: value front matter (agent, rank) and a "## Log" section. Convert them
-- to Backlog.md tasks once; the originals are moved to legacy/, not deleted.
local function migrate(board)
  if vim.fn.isdirectory(board) == 0 or vim.fn.isdirectory(vim.fs.joinpath(board, "tasks")) == 1 then return end
  local old = {}
  for name, kind in vim.fs.dir(board) do
    if kind == "file" and name:match("^%d+%-.*%.md$") then table.insert(old, name) end
  end
  local legacy = vim.fs.joinpath(board, "legacy")
  local readme = vim.fs.joinpath(board, "README.md")
  if #old > 0 then vim.fn.mkdir(legacy, "p") end
  -- The old README describes the old format; setup() writes the new one.
  if #old > 0 and vim.fn.filereadable(readme) == 1 then os.rename(readme, vim.fs.joinpath(legacy, "README.md")) end
  setup(board)
  if #old == 0 then return end
  for _, name in ipairs(old) do
    local path = vim.fs.joinpath(board, name)
    local card = parse(path)
    local id = "TASK-" .. tonumber(name:match("^(%d+)"))
    local body = card.body .. "\n"
    local at = body:find("\n## Log[ \t]*\n") or (body:match("^## Log[ \t]*\n") and 0)
    local description = at and body:sub(1, at) or body
    local log = at and body:sub(at + 1):gsub("^\n?## Log[ \t]*\n", "") or ""
    local stamp = now(vim.uv.fs_stat(path).mtime.sec)
    card.id, card.ordinal, card.rank = id, card.rank, nil
    card.path = vim.fs.joinpath(board, "tasks", filename(id, card.title))
    card.created_date, card.updated_date = stamp, stamp
    card.labels, card.dependencies = {}, {}
    card.body = sections(description, log)
    write(card)
    os.rename(path, vim.fs.joinpath(legacy, name))
  end
  vim.schedule(function()
    vim.notify(string.format("corkboard: board converted to Backlog.md (%d cards; originals in legacy/)", #old))
  end)
end

local function dir()
  local cwd = vim.fn.getcwd()
  if resolved[cwd] then return resolved[cwd] end
  local board = vim.fs.joinpath(boards, (cwd:gsub("^/", ""):gsub("/", "-")))
  -- Boards used to be <project>/.board. The first time a project is opened
  -- here its old board is copied over, never moved: the copy in the repo is
  -- the user's to delete.
  local old = vim.fs.joinpath(cwd, ".board")
  if vim.fn.isdirectory(board) == 0 and vim.fn.isdirectory(old) == 1 then
    vim.fn.mkdir(boards, "p")
    local result = vim.system({ "cp", "-r", old, board }):wait()
    -- Short, and after startup: this runs while the board is first drawn,
    -- where a message wider than the screen stops Neovim at a hit-enter
    -- prompt before the browser has attached.
    vim.schedule(function()
      if result.code == 0 then
        vim.notify("corkboard: board copied out of .board (safe to delete)")
      else
        vim.notify("corkboard: could not copy .board: " .. (result.stderr or ""), vim.log.levels.ERROR)
      end
    end)
  end
  migrate(board)
  resolved[cwd] = board
  return board
end

local function tasks() return vim.fs.joinpath(dir(), "tasks") end

function M.list()
  local cards = {}
  if vim.fn.isdirectory(tasks()) == 0 then return cards end
  for name, kind in vim.fs.dir(tasks()) do
    if kind == "file" and name:match("^%a+%-%d+ %- .*%.md$") then
      local card = parse(vim.fs.joinpath(tasks(), name))
      if card then table.insert(cards, card) end
    end
  end
  table.sort(cards, function(a, b)
    local oa, ob = tonumber(a.ordinal) or math.huge, tonumber(b.ordinal) or math.huge
    if oa ~= ob then return oa < ob end
    return number(a.id) < number(b.id)
  end)
  return cards
end

-- A card's file starts with its id; the rest is its title when created.
local function find(id)
  local prefix = id:lower() .. " - "
  for name in vim.fs.dir(tasks()) do
    if name:sub(1, #prefix) == prefix and name:match("%.md$") then
      local card = parse(vim.fs.joinpath(tasks(), name))
      if card and card.id == id then return card end
    end
  end
  error("no card " .. id)
end

-- Merge fields into a card; an empty string clears a field.
function M.set(id, fields)
  local card = find(id)
  for k, v in pairs(fields) do card[k] = v ~= "" and v or nil end
  card.updated_date = now()
  write(card)
  M.push()
end

function M.create(title, status, body)
  setup(dir())
  local n = 0
  for name in vim.fs.dir(tasks()) do
    n = math.max(n, tonumber(name:match("^%a+%-(%d+) %- ")) or 0)
  end
  local id = "TASK-" .. (n + 1)
  write({
    path = vim.fs.joinpath(tasks(), filename(id, title)),
    id = id,
    title = title,
    status = status or M.statuses[1],
    created_date = now(),
    updated_date = now(),
    labels = {},
    dependencies = {},
    body = sections(body, ""),
  })
  M.push()
  return id
end

-- Hand the card to an agent. Until the agent runner exists this only marks
-- it queued; anything watching the board (or a human) can pick it up.
function M.assign(id, agent)
  M.set(id, { agent = agent or "claude", agent_state = "queued", status = "ready" })
end

-- The agent://board buffer ----------------------------------------------------

local buf
local cards = {}
local line_card = {} -- line number -> card id
local selected -- card id under the cursor

local function board_wins()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return {} end
  return vim.fn.win_findbuf(buf)
end

local function line_of(id)
  for lnum, cid in pairs(line_card) do
    if cid == id then return lnum end
  end
end

local function card_lines()
  local lnums = vim.tbl_keys(line_card)
  table.sort(lnums)
  return lnums
end

local function column(status)
  return vim.tbl_filter(function(c) return c.status == status end, cards)
end

local function goto_card(id, win)
  local lnum = id and line_of(id)
  if lnum then vim.api.nvim_win_set_cursor(win or 0, { lnum, 2 }) end
end

local function state()
  return {
    root = vim.fn.getcwd(),
    statuses = M.statuses,
    selected = selected,
    cards = vim.tbl_map(function(c)
      return {
        id = c.id,
        title = c.title,
        status = c.status,
        agent = c.agent,
        agent_state = c.agent_state,
        attention = c.attention,
      }
    end, cards),
  }
end

local function push_state()
  require("corkboard").notify("corkboard.board", state())
end

local function render_text()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local lines, map = { "Board  " .. vim.fn.getcwd(), "" }, {}
  for _, status in ipairs(M.statuses) do
    local col = column(status)
    table.insert(lines, string.format("%s (%d)", status:upper(), #col))
    for _, c in ipairs(col) do
      local who = ""
      if c.agent or c.agent_state then
        who = "  [" .. (c.agent or "agent") .. (c.agent_state and (" · " .. c.agent_state) or "") .. "]"
      end
      table.insert(lines, "  " .. c.title .. who .. (c.attention and ("  ! " .. c.attention) or ""))
      map[#lines] = c.id
    end
    if #col == 0 then table.insert(lines, "  —") end
    table.insert(lines, "")
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  line_card = map

  -- Keep the cursor on the selected card when it moves or the list changes.
  if not (selected and line_of(selected)) then selected = line_card[card_lines()[1]] end
  for _, win in ipairs(board_wins()) do goto_card(selected, win) end
end

local function cursor_card()
  return line_card[vim.api.nvim_win_get_cursor(0)[1]]
end

-- j/k: next or previous card line, skipping headers.
function M.step(dir)
  local here = vim.api.nvim_win_get_cursor(0)[1]
  local lnums = card_lines()
  local target
  for i = dir > 0 and 1 or #lnums, dir > 0 and #lnums or 1, dir do
    if (dir > 0 and lnums[i] > here) or (dir < 0 and lnums[i] < here) then
      target = lnums[i]
      break
    end
  end
  if target then vim.api.nvim_win_set_cursor(0, { target, 2 }) end
end

-- h/l: same position in the nearest non-empty column that way.
function M.jump(dir)
  local id = cursor_card()
  local card = id and find(id)
  local from = card and vim.fn.index(M.statuses, card.status) + 1 or 1
  local index = 1
  if card then
    for i, c in ipairs(column(card.status)) do
      if c.id == id then index = i end
    end
  end
  local s = from + dir
  while s >= 1 and s <= #M.statuses do
    local col = column(M.statuses[s])
    if #col > 0 then return goto_card(col[math.min(index, #col)].id) end
    s = s + dir
  end
end

-- Cards open in one split to the right of the board, reused for the next
-- card. q in that split saves and closes it.
local card_win, card_buf

local function release_card_buf()
  if card_buf and vim.api.nvim_buf_is_valid(card_buf) then
    pcall(vim.keymap.del, "n", "q", { buffer = card_buf })
  end
  card_buf = nil
end

function M.open_card(id)
  -- Opening a card is seeing what its agent asked for. Cleared before the
  -- buffer loads, so it doesn't load a file about to change under it.
  if find(id).attention then M.set(id, { attention = "" }) end
  local b = vim.fn.bufadd(find(id).path)
  vim.fn.bufload(b)
  vim.bo[b].buflisted = true

  if card_win and vim.api.nvim_win_is_valid(card_win) then
    -- Save the card being replaced rather than leave it modified and hidden.
    vim.api.nvim_win_call(card_win, function() vim.cmd("silent update") end)
    release_card_buf()
    vim.api.nvim_win_set_buf(card_win, b)
    vim.api.nvim_set_current_win(card_win)
  else
    local host = vim.api.nvim_get_current_win()
    card_win = vim.api.nvim_open_win(b, true, {
      split = "right",
      win = host,
      width = math.max(40, math.floor(vim.api.nvim_win_get_width(host) * 0.4)),
    })
    local win = card_win
    vim.api.nvim_create_autocmd("WinClosed", {
      pattern = tostring(win),
      once = true,
      callback = function()
        release_card_buf()
        if card_win == win then card_win = nil end
      end,
    })
  end

  card_buf = b
  vim.keymap.set("n", "q", "<Cmd>update | close<CR>", { buffer = b, nowait = true, desc = "board: save and close card" })
end

-- Board actions on the card under the cursor; also what the HTML buttons call.
local actions = {
  left = function(id)
    local next = id and M.statuses[vim.fn.index(M.statuses, find(id).status)]
    if next then M.set(id, { status = next }) end
  end,
  right = function(id)
    local next = id and M.statuses[vim.fn.index(M.statuses, find(id).status) + 2]
    if next then M.set(id, { status = next }) end
  end,
  new = function(id)
    local status = id and find(id).status or "backlog"
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
  open = function(id)
    if id then M.open_card(id) end
  end,
  refresh = function()
    M.push()
  end,
}

-- win is set when the browser calls this for a click inside a board window.
function M.action(name, win)
  if not win then return actions[name](cursor_card()) end
  -- From the browser this runs inside an RPC request; "new" prompts with
  -- vim.ui.input, which must not block that request.
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

local function setup_buffer(b)
  vim.api.nvim_buf_set_name(b, "agent://board")
  vim.bo[b].filetype = "corkboard"
  vim.bo[b].modifiable = false
  vim.b[b].corkboard_view = "board"

  local function map(lhs, fn, desc)
    vim.keymap.set("n", lhs, fn, { buffer = b, nowait = true, desc = "board: " .. desc })
  end
  map("j", function() M.step(1) end, "next card")
  map("k", function() M.step(-1) end, "previous card")
  map("<Down>", function() M.step(1) end, "next card")
  map("<Up>", function() M.step(-1) end, "previous card")
  map("h", function() M.jump(-1) end, "column left")
  map("l", function() M.jump(1) end, "column right")
  map("H", function() M.action("left") end, "move card left")
  map("L", function() M.action("right") end, "move card right")
  map("o", function() M.action("new") end, "new card")
  map("a", function() M.action("assign") end, "hand to agent")
  map("<CR>", function() M.action("open") end, "open card")
  map("R", function() M.action("refresh") end, "refresh")

  vim.api.nvim_create_autocmd("CursorMoved", {
    buffer = b,
    callback = function()
      local id = cursor_card()
      if id and id ~= selected then
        selected = id
        push_state()
      end
    end,
  })
end

-- The board tab -------------------------------------------------------------
--
-- The board lives in tab 1 and cannot really be closed: Neovim has no way to
-- refuse a :tabclose, so ensure() runs after anything that could have closed
-- or moved it and puts it back.

local function board_tab()
  for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
    if vim.t[tab].corkboard_board then return tab end
  end
end

local function board_win(tab)
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    if vim.api.nvim_win_get_buf(win) == buf then return win end
  end
end

-- The unnamed, unmodified, empty window Neovim starts with.
local function empty_start(tab)
  local wins = vim.tbl_filter(function(w)
    return vim.api.nvim_win_get_config(w).relative == ""
  end, vim.api.nvim_tabpage_list_wins(tab))
  if #wins ~= 1 then return nil end
  local b = vim.api.nvim_win_get_buf(wins[1])
  local empty = vim.api.nvim_buf_get_name(b) == "" and not vim.bo[b].modified
    and vim.api.nvim_buf_line_count(b) == 1 and vim.api.nvim_buf_get_lines(b, 0, 1, false)[1] == ""
  return empty and wins[1] or nil
end

local ensuring = false

-- Keep the board tab first, with the board in it. Leaves focus where it was.
function M.ensure()
  if ensuring or vim.v.exiting ~= vim.NIL then return end
  ensuring = true
  local ok, err = pcall(function()
    if not (buf and vim.api.nvim_buf_is_valid(buf)) then
      buf = vim.api.nvim_create_buf(true, true)
      setup_buffer(buf)
    end
    local from = vim.api.nvim_get_current_win()
    local created = false

    local tab = board_tab()
    if not tab then
      local only = vim.api.nvim_list_tabpages()
      if #only == 1 and empty_start(only[1]) then
        tab = only[1]
      else
        vim.cmd("0tabnew")
        tab = vim.api.nvim_get_current_tabpage()
      end
      vim.t[tab].corkboard_board = true
      created = true
    end

    if vim.api.nvim_tabpage_get_number(tab) ~= 1 then
      vim.api.nvim_set_current_tabpage(tab)
      vim.cmd("tabmove 0")
    end

    if not board_win(tab) then
      vim.api.nvim_set_current_tabpage(tab)
      local win = empty_start(tab)
      if not win then
        vim.cmd("topleft vsplit")
        win = vim.api.nvim_get_current_win()
      end
      vim.api.nvim_win_set_buf(win, buf)
      created = true
    end

    if vim.api.nvim_win_is_valid(from) then vim.api.nvim_set_current_win(from) end
    if created then M.push() end
  end)
  ensuring = false
  if not ok then vim.notify("corkboard: " .. tostring(err), vim.log.levels.ERROR) end
end

-- Go to the board.
function M.show()
  M.ensure()
  local tab = board_tab()
  vim.api.nvim_set_current_tabpage(tab)
  vim.api.nvim_set_current_win(board_win(tab))
end

-- Watching -------------------------------------------------------------------

local watcher, watched

local function watch()
  if watched == dir() then return end
  if watcher then watcher:stop() end
  watcher, watched = nil, nil
  if vim.fn.isdirectory(tasks()) == 0 then return end
  watcher = assert(vim.uv.new_fs_event())
  watched = dir()
  local pending = false
  watcher:start(tasks(), {}, function()
    -- Editors write in several steps; settle before re-reading.
    if pending then return end
    pending = true
    vim.defer_fn(function()
      pending = false
      M.push()
    end, 50)
  end)
end

-- Re-read the cards, redraw the text buffer, and send the browser the board.
function M.push()
  watch()
  cards = M.list()
  render_text()
  push_state()
end

return M
