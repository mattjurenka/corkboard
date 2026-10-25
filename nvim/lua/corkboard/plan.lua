-- The day plan: every hour of today, filled from work ranked across
-- projects, and re-plans of it to accept or not.
--
-- Two views, each a listing with the browser's HTML drawn over it like the
-- board. agent://plan is the day: a column of today's blocks with the
-- ranked list beside it; the cursor's line selects a block.
-- agent://plan/proposal is a re-plan of the rest of the day as a diff
-- against the current plan, in hunks like a review: accepted whole, or
-- with hunks undone first.
--
-- Until it reads real projects and a calendar the plan is test data
-- (corkboard.plan.sample), and accepting writes nothing anywhere.

local pinned = require("corkboard.pinned")
local sample = require("corkboard.plan.sample")

local M = {}

local day = sample.day()
-- The re-plan waiting to be accepted, as sample.replan returns it.
local proposal
local asked = {}
local selected
local show_later = false
local plan_buf, diff_buf
-- Line number -> block id in the plan; -> hunk index in the diff.
local line_block, line_hunk, hunk_lines = {}, {}, {}
local selected_hunk = 1

local function clock(m) return string.format("%02d:%02d", math.floor(m / 60), m % 60) end

local function length(m)
  local h, rest = math.floor(m / 60), m % 60
  if h == 0 then return rest .. "m" end
  return rest == 0 and (h .. "h") or string.format("%dh%02d", h, rest)
end

local function now()
  local d = os.date("*t")
  return d.hour * 60 + d.min
end

local function find(blocks, id)
  for i, b in ipairs(blocks) do
    if b.id == id then return b, i end
  end
end

local function sort(blocks)
  table.sort(blocks, function(a, b) return a.start < b.start end)
end

-- The block under the clock, or the first one of the day.
local function current_block()
  local t = now()
  for _, b in ipairs(day.blocks) do
    if b.start <= t and t < b.stop then return b.id end
  end
  return day.blocks[1] and day.blocks[1].id
end

-- The diff ----------------------------------------------------------------------

-- The proposal against the plan, a line per block from proposal.from on:
-- " " unchanged, "+" added, "-" removed, "~" moved or retitled (was: the
-- old block). Hunks are runs of changed lines; each line knows its hunk.
local function diff()
  local before, seen, lines = {}, {}, {}
  for _, b in ipairs(day.blocks) do before[b.id] = b end
  for _, b in ipairs(proposal.blocks) do
    local o = before[b.id]
    seen[b.id] = true
    local op = not o and "+" or (o.start ~= b.start or o.stop ~= b.stop or o.title ~= b.title) and "~" or " "
    table.insert(lines, { op = op, block = b, was = op == "~" and o or nil })
  end
  for _, b in ipairs(day.blocks) do
    if not seen[b.id] then table.insert(lines, { op = "-", block = b }) end
  end
  lines = vim.tbl_filter(function(l) return l.block.stop > proposal.from end, lines)
  table.sort(lines, function(a, b)
    if a.block.start ~= b.block.start then return a.block.start < b.block.start end
    return a.op == "-" and b.op ~= "-"
  end)
  local hunks, hunk = {}, nil
  for _, l in ipairs(lines) do
    if l.op == " " then
      hunk = nil
    else
      if not hunk then
        hunk = { lines = {}, start = l.block.start, stop = l.block.stop }
        table.insert(hunks, hunk)
      end
      table.insert(hunk.lines, l)
      hunk.stop = math.max(hunk.stop, l.block.stop)
      l.hunk = #hunks
    end
  end
  return lines, hunks
end

local function counts(lines)
  local n = { ["+"] = 0, ["-"] = 0, ["~"] = 0 }
  for _, l in ipairs(lines) do
    if n[l.op] then n[l.op] = n[l.op] + 1 end
  end
  return n
end

-- What accepting would do.
local function effects(n)
  return {
    string.format("calendar: %d added, %d moved, %d removed", n["+"], n["~"], n["-"]),
    "test data: nothing is written to a calendar yet",
  }
end

-- State for the page ---------------------------------------------------------------

local function plan_state()
  local focus, fixed = 0, 0
  for _, b in ipairs(day.blocks) do
    if b.kind == "work" then focus = focus + b.stop - b.start end
    if b.kind == "fixed" then fixed = fixed + 1 end
  end
  return {
    date = os.date("%a %d %b"),
    now = now(),
    test = true,
    projects = sample.projects,
    blocks = day.blocks,
    selected = selected,
    ranked = day.ranked,
    later = show_later and day.later or nil,
    later_count = #day.later,
    inputs = day.inputs,
    focus = length(focus),
    fixed = fixed,
    proposal = proposal ~= nil,
  }
end

local function diff_state()
  local lines, hunks = diff()
  return {
    date = os.date("%a %d %b"),
    from = clock(proposal.from),
    test = true,
    projects = sample.projects,
    reasons = proposal.reasons,
    lines = vim.tbl_map(function(l)
      return {
        op = l.op, hunk = l.hunk, id = l.block.id, start = l.block.start, stop = l.block.stop,
        title = l.block.title, kind = l.block.kind, project = l.block.project, card = l.block.card,
        was = l.was and clock(l.was.start) or nil,
      }
    end, lines),
    hunks = vim.tbl_map(function(h)
      local why, seen = {}, {}
      for _, l in ipairs(h.lines) do
        local w = proposal.why[l.block.id]
        if w and not seen[w] then
          seen[w] = true
          table.insert(why, w)
        end
      end
      return { start = h.start, stop = h.stop, why = why, counts = counts(h.lines) }
    end, hunks),
    counts = counts(lines),
    selected = selected_hunk,
    effects = effects(counts(lines)),
    asked = asked,
  }
end

local function notify_page()
  local corkboard = require("corkboard")
  corkboard.notify("corkboard.plan", plan_state())
  if proposal then corkboard.notify("corkboard.plan_diff", diff_state()) end
end

-- Text under the HTML --------------------------------------------------------------

local function pin_of(b)
  return b.kind == "fixed" and "◇" or b.kind == "off" and "·" or "●"
end

local function render_plan()
  if not (plan_buf and vim.api.nvim_buf_is_valid(plan_buf)) then return end
  local lines, map = { "Day plan  " .. os.date("%a %d %b") .. "  (test data)", "" }, {}
  for _, b in ipairs(day.blocks) do
    table.insert(lines, string.format("  %s–%s  %s %-48s %s%s", clock(b.start), clock(b.stop), pin_of(b), b.title,
      b.tag or "", b.pinned and "  pinned" or ""))
    map[#lines] = b.id
  end
  vim.list_extend(lines, { "", "PRIORITY" })
  for i, r in ipairs(day.ranked) do
    table.insert(lines, string.format("  %d. %-40s %5s  %s", i, r.title, r.est, r.why))
  end
  table.insert(lines, "")
  table.insert(lines, string.format("NOT TODAY (%d)%s", #day.later, show_later and "" or "  z to show"))
  if show_later then
    for _, l in ipairs(day.later) do table.insert(lines, "  " .. l.title .. "  " .. l.why) end
  end
  pinned.set_lines(plan_buf, lines)
  line_block = map
  pinned.follow(plan_buf, line_block, selected)
end

local function render_diff()
  if not (proposal and diff_buf and vim.api.nvim_buf_is_valid(diff_buf)) then return end
  local lines, hunks = diff()
  local text = { "Re-plan of " .. os.date("%a %d %b") .. " from " .. clock(proposal.from) .. "  (test data)", "" }
  for _, r in ipairs(proposal.reasons) do table.insert(text, "  why now: " .. r.text .. " (" .. r.source .. ")") end
  table.insert(text, "")
  local map, heads, last = {}, {}, nil
  for _, l in ipairs(lines) do
    if l.hunk and l.hunk ~= last then
      local h = hunks[l.hunk]
      table.insert(text, string.format("@@ %s–%s @@", clock(h.start), clock(h.stop)))
      map[#text] = l.hunk
      heads[#text] = l.hunk
    end
    last = l.hunk
    local b = l.block
    table.insert(text, string.format("%s %s–%s  %s %-44s %s", l.op, clock(b.start), clock(b.stop), pin_of(b), b.title,
      l.was and ("was " .. clock(l.was.start)) or ""))
    if l.hunk then map[#text] = l.hunk end
  end
  if #hunks == 0 then table.insert(text, "  no changes left: q keeps the plan as it is") end
  pinned.set_lines(diff_buf, text)
  line_hunk, hunk_lines = map, heads
  selected_hunk = math.min(selected_hunk, math.max(#hunks, 1))
end

local function redraw()
  render_plan()
  render_diff()
  notify_page()
end

-- Tabs -------------------------------------------------------------------------------

-- Go to buf's window, in whichever tab; or a new tab for it, at the end.
local function show_buf(buf)
  local win = vim.fn.win_findbuf(buf)[1]
  if win then return vim.api.nvim_set_current_win(win) end
  vim.cmd("$tabnew")
  local empty = vim.api.nvim_get_current_buf()
  vim.api.nvim_win_set_buf(0, buf)
  if empty ~= buf then pcall(vim.api.nvim_buf_delete, empty, {}) end
end

-- Close the proposal's tab (its window, when it shares one) and go back to
-- the plan.
local function close_diff()
  if diff_buf and vim.api.nvim_buf_is_valid(diff_buf) then
    for _, win in ipairs(vim.fn.win_findbuf(diff_buf)) do
      local tab = vim.api.nvim_win_get_tabpage(win)
      if #vim.api.nvim_tabpage_list_wins(tab) == 1 and #vim.api.nvim_list_tabpages() > 1 then
        pcall(vim.cmd.tabclose, vim.api.nvim_tabpage_get_number(tab))
      elseif #vim.api.nvim_tabpage_list_wins(tab) > 1 then
        pcall(vim.api.nvim_win_close, win, true)
      else
        vim.api.nvim_win_set_buf(win, M.buffer())
      end
    end
  end
  M.show()
end

-- Actions ----------------------------------------------------------------------------

local function open_card(id)
  if not id then return vim.notify("corkboard: this block has no card") end
  if not pcall(require("corkboard.cards").get, id) then
    return vim.notify("corkboard: " .. id .. " is test data, not a card on this board")
  end
  require("corkboard.board").reveal(id)
end

-- Make a re-plan (the sample's) and show it; the one waiting, if there is.
function M.replan()
  if not proposal then
    proposal = sample.replan(day.blocks)
    asked = {}
    selected_hunk = 1
  end
  show_buf(M.diff_buffer())
  redraw()
  local head = pinned.line_of(hunk_lines, selected_hunk)
  if head then vim.api.nvim_win_set_cursor(0, { head, 0 }) end
end

function M.accept()
  if not proposal then return end
  day.blocks = proposal.blocks
  proposal = nil
  if not find(day.blocks, selected) then selected = current_block() end
  close_diff()
  redraw()
  vim.notify("corkboard: re-plan accepted (test data: nothing written to a calendar)")
end

function M.discard()
  proposal = nil
  close_diff()
  redraw()
end

-- Put the hunk's blocks back as the current plan has them.
function M.undo_hunk(i)
  if not proposal then return end
  local _, hunks = diff()
  local hunk = hunks[i or selected_hunk]
  if not hunk then return end
  for _, l in ipairs(hunk.lines) do
    local _, at = find(proposal.blocks, l.block.id)
    if l.op == "+" then
      table.remove(proposal.blocks, at)
    elseif l.op == "-" then
      table.insert(proposal.blocks, vim.deepcopy(l.block))
    elseif l.op == "~" then
      proposal.blocks[at] = vim.deepcopy(l.was)
    end
    proposal.why[l.block.id] = nil
  end
  sort(proposal.blocks)
  redraw()
end

-- What to change, for whoever makes the next re-plan. With test data it is
-- only kept and shown.
function M.say()
  vim.ui.input({ prompt = "Change the plan: " }, function(text)
    if not (text and vim.trim(text) ~= "") then return end
    table.insert(asked, vim.trim(text))
    redraw()
  end)
end

local function step_hunk(dir)
  pinned.step(hunk_lines, dir)
end

local function selected_block() return find(day.blocks, selected) end

function M.edit()
  local b = selected_block()
  if not b then return end
  vim.ui.input({ prompt = clock(b.start) .. "–" .. clock(b.stop) .. ": ", default = b.title }, function(title)
    if not (title and vim.trim(title) ~= "") then return end
    b.title = vim.trim(title)
    redraw()
  end)
end

-- A pinned block stays put when the day is re-planned.
function M.pin()
  local b = selected_block()
  if not b or b.kind ~= "work" then return end
  b.pinned = not b.pinned or nil
  redraw()
end

function M.toggle_later()
  show_later = not show_later
  redraw()
end

-- Start again from the sample day.
function M.reset()
  day, proposal, asked = sample.day(), nil, {}
  selected = current_block()
  if diff_buf and vim.api.nvim_buf_is_valid(diff_buf) and #vim.fn.win_findbuf(diff_buf) > 0 then close_diff() end
  redraw()
end

local PLAN_ACTIONS = {
  replan = M.replan,
  edit = M.edit,
  pin = M.pin,
  later = M.toggle_later,
  open = function() open_card((selected_block() or {}).card) end,
  reset = M.reset,
}

local DIFF_ACTIONS = {
  accept = M.accept,
  undo = function() M.undo_hunk() end,
  next = function() step_hunk(1) end,
  prev = function() step_hunk(-1) end,
  say = M.say,
  discard = M.discard,
  open = function()
    for _, l in ipairs(diff_state().lines) do
      if l.hunk == selected_hunk and l.card then return open_card(l.card) end
    end
    open_card(nil)
  end,
}

-- A key hint or double-click in the browser.
function M.action(view, name, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local fn = (view == "plan-diff" and DIFF_ACTIONS or PLAN_ACTIONS)[name]
  if fn then fn() end
end

-- A click on a block in the browser.
function M.select(id, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(line_block, id)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
end

-- A click on a hunk in the browser.
function M.select_hunk(i, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(hunk_lines, i)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 0 }) end
end

-- Buffers ------------------------------------------------------------------------------

local function keys(actions, list)
  local out = {}
  for lhs, entry in pairs(list) do out[lhs] = { actions[entry[1]], entry[2] } end
  return out
end

function M.buffer()
  if plan_buf and vim.api.nvim_buf_is_valid(plan_buf) then return plan_buf end
  local step = function(dir) return function() pinned.step(line_block, dir) end end
  local k = keys(PLAN_ACTIONS, {
    r = { "replan", "re-plan the rest of the day" },
    e = { "edit", "edit the block" },
    p = { "pin", "pin the block" },
    z = { "later", "show what's not today" },
    ["<CR>"] = { "open", "open the block's card" },
    R = { "reset", "start over from the test data" },
  })
  k.j = { step(1), "next block" }
  k.k = { step(-1), "previous block" }
  k["<Down>"] = k.j
  k["<Up>"] = k.k
  plan_buf = pinned.listing("agent://plan", "plan", k, function() return line_block end, function(id)
    if id == selected then return end
    selected = id
    notify_page()
  end)
  selected = selected or current_block()
  return plan_buf
end

function M.diff_buffer()
  if diff_buf and vim.api.nvim_buf_is_valid(diff_buf) then return diff_buf end
  diff_buf = pinned.listing("agent://plan/proposal", "plan-diff", keys(DIFF_ACTIONS, {
    A = { "accept", "accept the re-plan" },
    u = { "undo", "undo this hunk" },
    ["]h"] = { "next", "next hunk" },
    ["[h"] = { "prev", "previous hunk" },
    S = { "say", "say what to change" },
    q = { "discard", "keep the old plan" },
    ["<CR>"] = { "open", "open the hunk's card" },
  }), function() return line_hunk end, function(i)
    if i == selected_hunk then return end
    selected_hunk = i
    notify_page()
  end)
  -- Neither :q nor closing the tab should lose the plan; the proposal
  -- waits for r.
  vim.bo[diff_buf].bufhidden = "hide"
  return diff_buf
end

-- Keep the plan first among the tabs. Leaves focus where it was.
function M.ensure()
  if pinned.ensure("corkboard_plan", 1, M.buffer()) then redraw() end
end

-- The plan's tab (<leader>p, :AgentPlan).
function M.show()
  M.ensure()
  pinned.show("corkboard_plan", 1, M.buffer())
  redraw()
end

-- For a channel that just attached: the last state again, if the view exists.
function M.push_all()
  if plan_buf and vim.api.nvim_buf_is_valid(plan_buf) then notify_page() end
end

return M
