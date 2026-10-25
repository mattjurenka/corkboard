-- Card files: a Backlog.md board (https://github.com/MrLesk/Backlog.md), one
-- markdown file per card in <board>/tasks/:
--
-- ---
-- id: TASK-6
-- title: Render ext_cmdline as HTML
-- status: doing
-- assignee:
--   - claude
-- agent_state: working
-- ---
-- ## Description / ## Implementation Notes, each between SECTION markers.
--
-- mcp/board.ts reads and writes the same files and must agree with this
-- byte for byte (test/cards.test.ts checks). Both take the same per-card
-- lock and write through a rename, so neither ever reads half a file.

local util = require("corkboard.util")

local M = {}

M.statuses = { "backlog", "ready", "doing", "review", "done" }

-- Backlog.md's, highest first; a card without one counts as medium.
M.priorities = { "high", "medium", "low" }
local RANK = { high = 1, low = 3 }
function M.rank(card) return RANK[card.priority] or 2 end

-- Backlog.md's keys in the order it writes them, then corkboard's own.
local KEY_ORDER = {
  "id", "title", "status", "assignee", "created_date", "updated_date",
  "labels", "dependencies", "priority", "ordinal", "agent_state", "attention",
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
- `priority`: high | medium | low; none is medium. Higher sorts first within
  a column, and agents start on it first.
- `ordinal`: optional number; lower sorts first within a column., among
  cards of the same priority.
- `agent_state` (corkboard): queued | working | blocked | needs-review | done
- `attention` (corkboard): what the agent needs the user to do, one line;
  corkboard sends a desktop notification when it is set, and clears it when
  the user opens the card.
- `worktree`, `branch` (corkboard): where the card's agent works, set when
  corkboard starts one on it.

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

-- Front matter ----------------------------------------------------------------
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

-- Quoted whenever YAML could read it as something else (a number, date,
-- boolean, list or mapping), the way Backlog.md quotes its dates.
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

-- Files -----------------------------------------------------------------------

local function now() return os.date("%Y-%m-%d %H:%M") end

-- TASK-12 -> 12.
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

-- A card body from its two sections, for cards/cloud.lua.
M.body = sections

function M.parse(path)
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
  -- One agent per card: the first assignee.
  if card.assignee then card.agent = card.assignee[1] and card.assignee[1]:gsub("^@", "") end
  return card
end

function M.serialize(card)
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
  local tmp = vim.fs.joinpath(vim.fs.dirname(card.path), "." .. card.id .. ".md.tmp")
  local f = assert(io.open(tmp, "w"))
  f:write(M.serialize(card))
  f:close()
  assert(vim.uv.fs_rename(tmp, card.path))
end

-- The board ---------------------------------------------------------------------

-- A project's board lives outside it, so cards stay out of its git history:
-- $XDG_DATA_HOME/corkboard/boards/<project path with / as ->. CORKBOARD_BOARD
-- overrides it, as it does for mcp/board.ts.
function M.dir()
  return vim.env.CORKBOARD_BOARD or util.data_dir("boards", util.path_key(vim.fn.getcwd()))
end

function M.tasks_dir() return vim.fs.joinpath(M.dir(), "tasks") end

-- tasks/, and config.yml and the README for the backlog CLI and for agents.
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

-- One writer per card: mkdir makes the lock or fails. A lock older than ten
-- seconds is from a process that died holding it. Same scheme and names as
-- mcp/board.ts's locked().
local function locked(id, fn)
  local lock = vim.fs.joinpath(M.tasks_dir(), "." .. id:upper() .. ".lock")
  local ms = function() return vim.uv.hrtime() / 1e6 end
  local deadline = ms() + 3000
  while true do
    local made, err, code = vim.uv.fs_mkdir(lock, tonumber("700", 8))
    if made then break end
    if code ~= "EEXIST" then error(err, 0) end
    local stat = vim.uv.fs_stat(lock)
    if stat and os.time() - stat.mtime.sec > 10 then vim.uv.fs_rmdir(lock) end
    if ms() > deadline then error("card " .. id .. " is busy; try again", 0) end
    vim.uv.sleep(20)
  end
  local ok, result = pcall(fn)
  vim.uv.fs_rmdir(lock)
  if not ok then error(result, 0) end
  return result
end

function M.list()
  local cards, tasks = {}, M.tasks_dir()
  if vim.fn.isdirectory(tasks) == 0 then return cards end
  for name, kind in vim.fs.dir(tasks) do
    if kind == "file" and name:match("^%a+%-%d+ %- .*%.md$") then
      local card = M.parse(vim.fs.joinpath(tasks, name))
      if card then table.insert(cards, card) end
    end
  end
  table.sort(cards, function(a, b)
    if M.rank(a) ~= M.rank(b) then return M.rank(a) < M.rank(b) end
    local oa, ob = tonumber(a.ordinal) or math.huge, tonumber(b.ordinal) or math.huge
    if oa ~= ob then return oa < ob end
    return number(a.id) < number(b.id)
  end)
  return cards
end

-- A card's file starts with its id; the rest is its title when created.
function M.get(id)
  id = id:upper()
  local tasks, prefix = M.tasks_dir(), id:lower() .. " - "
  if vim.fn.isdirectory(tasks) == 1 then
    for name in vim.fs.dir(tasks) do
      if name:sub(1, #prefix) == prefix and name:match("%.md$") then
        local card = M.parse(vim.fs.joinpath(tasks, name))
        if card and card.id == id then return card end
      end
    end
  end
  error("no card " .. id, 0)
end

-- Read, change and write a card under its lock.
function M.change(id, fn)
  return locked(id, function()
    local card = M.get(id)
    fn(card)
    card.updated_date = now()
    write(card)
    return card
  end)
end

-- Merge fields into a card; an empty string clears a field.
function M.set(id, fields)
  return M.change(id, function(card)
    for k, v in pairs(fields) do card[k] = v ~= "" and v or nil end
  end)
end

function M.create(title, status, body)
  setup(M.dir())
  -- Numbered under a board-wide lock, shared with mcp/board.ts.
  return locked("new", function()
    local n = 0
    for name in vim.fs.dir(M.tasks_dir()) do
      n = math.max(n, tonumber(name:match("^%a+%-(%d+) %- ")) or 0)
    end
    local id = "TASK-" .. (n + 1)
    write({
      path = vim.fs.joinpath(M.tasks_dir(), filename(id, title)),
      id = id,
      title = title,
      status = status or M.statuses[1],
      created_date = now(),
      updated_date = now(),
      labels = {},
      dependencies = {},
      body = sections(body, ""),
    })
    return id
  end)
end

-- Body sections -----------------------------------------------------------------

local function pattern(name)
  return "(<!%-%- SECTION:" .. name .. ":BEGIN %-%->\n?)(.-)(<!%-%- SECTION:" .. name .. ":END %-%->)"
end

-- The text of a card's DESCRIPTION or NOTES section.
function M.section(card, name)
  return vim.trim(select(2, (card.body or ""):match(pattern(name))) or "")
end

function M.set_description(card, text)
  text = vim.trim(text)
  local body = card.body or ""
  if body:match(pattern("DESCRIPTION")) then
    -- A function replacement, so % in the text is not a capture reference.
    card.body = body:gsub(pattern("DESCRIPTION"), function(open, _, close)
      return open .. (text ~= "" and text .. "\n" or "") .. close
    end, 1)
  else
    card.body = "\n" .. section("Description", "DESCRIPTION", text) .. body
  end
end

-- Append `- <ISO time> <who>: <note>` to the notes (the card's log), before
-- the last NOTES:END marker as mcp/board.ts does.
function M.append_log(card, who, note)
  local entry = string.format("- %s %s: %s\n", os.date("!%Y-%m-%dT%H:%M:%SZ"), who, (vim.trim(note):gsub("\n", "\n  ")))
  local body, marker = card.body or "", "<!-- SECTION:NOTES:END -->"
  local at, from = nil, 1
  while true do
    local i = body:find(marker, from, true)
    if not i then break end
    at, from = i, i + 1
  end
  if at then
    card.body = body:sub(1, at - 1):gsub("\n*$", "\n") .. entry .. body:sub(at)
  else
    card.body = body:gsub("\n*$", "\n") .. "\n" .. section("Implementation Notes", "NOTES", entry)
  end
end

function M.log(id, who, note)
  return M.change(id, function(card) M.append_log(card, who, note) end)
end

-- The dependencies a card still waits on, as { id, missing }: those not done,
-- and ids with no card (missing), which never will be. nil when there are
-- none, and for a done card.
function M.waiting_on(card, cards)
  if card.status == "done" then return nil end
  local status = {}
  for _, c in ipairs(cards) do status[c.id] = c.status end
  local waiting = {}
  for _, dep in ipairs(card.dependencies or {}) do
    dep = dep:upper()
    if status[dep] ~= "done" then table.insert(waiting, { id = dep, missing = status[dep] == nil }) end
  end
  return #waiting > 0 and waiting or nil
end

-- Cloud boards ------------------------------------------------------------------
--
-- Under the bridge the board is the Worker's (cards/cloud.lua), and these go
-- there instead of to the files, unless CORKBOARD_CLOUD_BOARDS=0.

local cloud = require("corkboard.cards.cloud")

for _, name in ipairs({ "list", "get", "change", "set", "create", "log" }) do
  local files = M[name]
  M[name] = function(...)
    if cloud.enabled() then return cloud[name](...) end
    return files(...)
  end
end

M.cloud = cloud.enabled
M.cloud_event = cloud.event
M.agent_token = cloud.agent_token
M.revoke_agent_token = cloud.revoke
M.touch = cloud.touch
-- fn runs after the cloud board changes; the file board has its watcher.
M.on_change = cloud.on_change

return M
