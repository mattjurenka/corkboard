-- Cards from corkboard's Worker instead of files: the same functions as
-- corkboard.cards, over a copy of the board the bridge keeps live
-- (bridge/boards.ts). Reads come from the copy; writes go through the
-- bridge to the Worker and come back as the card the Worker wrote.
--
-- Cards come out shaped like file cards, body included, so the callers'
-- section(), set_description() and append_log() work unchanged; change()
-- turns what a callback did to that shape back into fields and log entries.
--
-- On whenever Neovim runs under the bridge, which listens for
-- "corkboard.cloud" on Neovim's stdio channel. CORKBOARD_CLOUD_BOARDS=0
-- turns it off, back to the card files.
--
-- Requests are a notification and a wait, not rpcrequest(). Neovim handles
-- the page's calls while it waits, and those can ask for cards too; with
-- rpcrequest() it then accepts only the innermost answer, and the bridge
-- can't know which that is. Waiting on an id takes answers in any order.

local util = require("corkboard.util")

local M = {}

-- The bridge's channel: Neovim's stdio, when it's an RPC channel.
local function channel()
  for _, chan in ipairs(vim.api.nvim_list_chans()) do
    if chan.stream == "stdio" and chan.mode == "rpc" then return chan.id end
  end
end

function M.enabled() return vim.env.CORKBOARD_CLOUD_BOARDS ~= "0" and channel() ~= nil end

local waiting, answers, last_id = {}, {}, 0

local function request(op, ...)
  local chan = channel()
  if not chan then error("corkboard: cloud boards need the bridge", 0) end
  last_id = last_id + 1
  local id = last_id
  waiting[id] = true
  vim.rpcnotify(chan, "corkboard.cloud", id, op, ...)
  local answered = vim.wait(30000, function() return answers[id] ~= nil end, 5)
  waiting[id] = nil
  local answer = answers[id]
  answers[id] = nil
  if not answered then error("corkboard: the cloud didn't answer " .. op .. " in 30s", 0) end
  if answer.error then error(answer.error, 0) end
  return answer.result
end

-- A note on the Worker, made or replaced: { kind, title, body }.
function M.note_put(id, note) return request("note_put", id, note) end

-- The bridge's answer: { id, error?, result? }.
function M.answer(a)
  if waiting[a.id] then answers[a.id] = a end
end

-- The board's key, as the file boards name their directories.
local function key()
  if vim.env.CORKBOARD_BOARD then return vim.fs.basename(vim.env.CORKBOARD_BOARD) end
  return util.path_key(vim.fn.getcwd())
end

-- The copies: key -> { cards = { [id] = card as the Worker sends it }, logs = { [id] = { entries } } }.
local copies = {}
local listeners = {}

-- Cards and their log entries as the Worker answers or sends them.
local function put_card(copy, card)
  local had = copy.cards[card.id]
  if not had or card.version >= had.version then copy.cards[card.id] = card end
end

local function put_entry(copy, id, entry)
  local log = copy.logs[id] or {}
  copy.logs[id] = log
  for _, e in ipairs(log) do
    if e.seq == entry.seq then return end
  end
  table.insert(log, entry)
  table.sort(log, function(a, b) return a.seq < b.seq end)
end

local function load(copy, cards)
  -- No board: the bridge's null, which arrives as vim.NIL.
  local missing = cards == nil or cards == vim.NIL
  copy.cards, copy.logs, copy.missing = {}, {}, missing
  if missing then return end
  for _, c in ipairs(cards) do
    local log = c.log or {}
    c.log, c.waiting_on = nil, nil
    copy.cards[c.id] = c
    copy.logs[c.id] = log
  end
end

-- make: make the board if there isn't one, for its first card. Otherwise a
-- project with no board reads as an empty one, and stays off the Worker.
local function copy_of(k, make)
  k = k or key()
  if copies[k] and copies[k].missing and make then copies[k] = nil end
  if not copies[k] then
    local cwd = vim.fn.getcwd()
    local cards = request("subscribe", k, vim.fs.basename(cwd), cwd, make or false)
    -- A call made while this one waited may have subscribed already and
    -- written since; its copy is newer than this answer.
    if not copies[k] or (make and copies[k].missing) then
      local copy = {}
      load(copy, cards)
      copies[k] = copy
    end
  end
  return copies[k]
end

-- What happened, from the bridge. Listeners hear of it once per batch.
local pending = false

function M.event(k, event)
  local copy = copies[k]
  if not copy then return end
  if event.type == "snapshot" then
    load(copy, event.cards)
  elseif event.type == "card" then
    put_card(copy, event.card)
  elseif event.type == "log" then
    put_entry(copy, event.id, event.entry)
  end
  if pending then return end
  pending = true
  vim.schedule(function()
    pending = false
    for _, fn in ipairs(listeners) do fn() end
  end)
end

function M.on_change(fn) table.insert(listeners, fn) end

-- Shapes --------------------------------------------------------------------------

-- The fields a card file has that the Worker keeps as columns. Anything else
-- a caller sets (worktree, branch) goes in the card's extra.
local FIELDS = { "title", "status", "agent", "agent_state", "attention", "priority", "ordinal", "labels", "dependencies" }
local DERIVED = { id = true, body = true, path = true, version = true, created_date = true, updated_date = true }
for _, f in ipairs(FIELDS) do DERIVED[f] = true end

local function notes(log)
  return table.concat(vim.tbl_map(function(e)
    return string.format("- %s %s: %s", e.at, e.who, (e.note:gsub("\n", "\n  ")))
  end, log), "\n")
end

-- A Worker card as corkboard.cards' callers know cards.
local function shaped(copy, c)
  local card = {
    id = c.id,
    version = c.version,
    created_date = c.created,
    updated_date = c.updated,
    labels = vim.deepcopy(c.labels or {}),
    dependencies = vim.deepcopy(c.dependencies or {}),
  }
  for _, f in ipairs(FIELDS) do
    if card[f] == nil and c[f] ~= vim.NIL then card[f] = c[f] end
  end
  for k, v in pairs(c.extra or {}) do
    if not DERIVED[k] then card[k] = v end
  end
  card.body = require("corkboard.cards").body(c.description or "", notes(copy.logs[c.id] or {}))
  return card
end

-- New entries at the end of a card's notes, as { who, note }. Earlier
-- entries can't change: the log only grows.
local function appended(before, after)
  if after == before then return {} end
  if after:sub(1, #before) ~= before then error("corkboard: a card's log can only be added to", 0) end
  local entries = {}
  for line in vim.gsplit(vim.trim(after:sub(#before + 1)), "\n", { plain = true }) do
    local who, note = line:match("^%- %S+ ([^:]+): (.*)$")
    if who then
      table.insert(entries, { who = who, note = note })
    elseif #entries > 0 then
      local e = entries[#entries]
      e.note = e.note .. "\n" .. line:gsub("^  ", "")
    end
  end
  return entries
end

local function null(v)
  if v == nil or v == "" then return vim.NIL end
  return v
end

-- What fn did to the card, as a PATCH and log entries.
local function diff(before, after)
  local cards = require("corkboard.cards")
  local fields = {}
  for _, f in ipairs(FIELDS) do
    if not vim.deep_equal(before[f], after[f]) then
      if f == "labels" or f == "dependencies" then
        fields[f] = after[f] or {}
      elseif f == "ordinal" then
        fields[f] = tonumber(after[f]) or vim.NIL
      else
        fields[f] = null(after[f])
      end
    end
  end
  local description = cards.section(after, "DESCRIPTION")
  if description ~= cards.section(before, "DESCRIPTION") then fields.description = description end
  local extra, changed = {}, false
  for k in pairs(vim.tbl_extend("force", {}, before, after)) do
    if not DERIVED[k] then
      if after[k] ~= nil and after[k] ~= "" then extra[k] = after[k] end
      if not vim.deep_equal(before[k], after[k]) then changed = true end
    end
  end
  if changed then fields.extra = next(extra) and extra or vim.empty_dict() end
  return fields, appended(cards.section(before, "NOTES"), cards.section(after, "NOTES"))
end

-- corkboard.cards' functions ---------------------------------------------------------

-- As the Worker lists them: by priority, then ordinal, then number.
local function by_board_order(a, b)
  local rank = require("corkboard.cards").rank
  if rank(a) ~= rank(b) then return rank(a) < rank(b) end
  local oa, ob = tonumber(a.ordinal) or math.huge, tonumber(b.ordinal) or math.huge
  if oa ~= ob then return oa < ob end
  return tonumber(a.id:match("%d+$")) < tonumber(b.id:match("%d+$"))
end

function M.list()
  local copy = copy_of()
  local cards = {}
  for _, c in pairs(copy.cards) do table.insert(cards, shaped(copy, c)) end
  table.sort(cards, by_board_order)
  return cards
end

function M.get(id)
  id = id:upper()
  local copy = copy_of()
  local c = copy.cards[id]
  if not c then error("no card " .. id, 0) end
  return shaped(copy, c)
end

-- fn changes a card-shaped copy; what it changed is sent as one update, and
-- any notes it appended as log entries. On a conflict (someone else wrote
-- the card since it was read), fn runs again on the card as it is now.
function M.change(id, fn)
  id = id:upper()
  local k = key()
  local copy = copy_of(k)
  for _ = 1, 3 do
    local before = M.get(id)
    local after = vim.deepcopy(before)
    fn(after)
    local fields, entries = diff(before, after)
    local conflict = false
    if next(fields) then
      local res = request("update", k, id, before.version, fields)
      if res.conflict then
        put_card(copy, res.conflict)
        conflict = true
      else
        put_card(copy, res.card)
      end
    end
    if not conflict then
      for _, e in ipairs(entries) do put_entry(copy, id, request("log", k, id, e.who, e.note)) end
      return M.get(id)
    end
  end
  error("card " .. id .. " keeps changing under us; try again", 0)
end

function M.set(id, fields)
  return M.change(id, function(card)
    for k, v in pairs(fields) do card[k] = v ~= "" and v or nil end
  end)
end

function M.create(title, status, body)
  local k = key()
  local copy = copy_of(k, true)
  local card = request("create", k, { title = title, status = status or "backlog", description = vim.trim(body or "") })
  put_card(copy, card)
  copy.logs[card.id] = copy.logs[card.id] or {}
  return card.id
end

-- Any of the bridge's operations, for corkboard.plan's plan_* ones.
M.call = request

-- A token for agent's MCP session on card id: { token, url, expires_at }.
-- It can read the board and work on that card only.
function M.agent_token(id, agent) return request("token", key(), id:upper(), agent) end

function M.revoke(token) request("revoke", key(), token) end

-- A token for Pepper's MCP session, the only one that sees the goals:
-- { token, url, expires_at }.
function M.pepper_token() return request("pepper_token") end

-- Tell the Worker card id's agent is still running, so its claim doesn't
-- lapse (cloud/src/board.ts's leases). Not waited for: a heartbeat that
-- doesn't arrive is made up by the next one.
function M.touch(id, agent)
  local chan = channel()
  if not chan then return end
  last_id = last_id + 1
  vim.rpcnotify(chan, "corkboard.cloud", last_id, "touch", key(), id:upper(), agent)
end

function M.log(id, who, note)
  id = id:upper()
  local k = key()
  put_entry(copy_of(k), id, request("log", k, id, who, vim.trim(note)))
  return M.get(id)
end

return M
