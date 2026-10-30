-- The day plan: every hour of today, filled from work ranked across
-- projects, and re-plans of it to accept or not.
--
-- Its tab is three windows, each a listing with the browser's HTML drawn
-- over it like the board: agent://plan/goals above agent://plan/priority
-- (what's ranked across projects) on the left, and agent://plan, the day,
-- beside them (a column of today's blocks; the cursor's line selects a
-- block).
-- agent://plan/proposal is a re-plan of the rest of the day as a diff
-- against the current plan, in hunks like a review: accepted whole, or
-- with hunks undone first.
--
-- The plan is today's on corkboard's Worker (cloud/src/plans.ts), read
-- through the bridge and followed live: the assistant proposes (MCP
-- plan_propose), the proposal shows here as a diff against the day, and
-- accepting it, which only happens here, writes the Claude calendar with
-- `dayplan apply` and then tells the Worker. A first plan of the day is a
-- proposal against an empty day. It lives in the day plan's window
-- (corkboard.window == "plan").

local pinned = require("corkboard.pinned")

local M = {}

local function cloud() return require("corkboard.cards.cloud") end

-- The day turns over at 4am, not midnight, as dayplan's does: until then it
-- is still the day planned yesterday.
local DAY_STARTS_HOUR = 4
local function this_day() return os.date("%Y-%m-%d", os.time() - DAY_STARTS_HOUR * 3600) end

-- The plan's date: today, or CORKBOARD_PLAN_DATE for tests, which must not
-- touch today's.
local function today() return vim.env.CORKBOARD_PLAN_DATE or this_day() end

-- What writes the calendar; CORKBOARD_DAYPLAN in tests, which must not.
local DAYPLAN = vim.env.CORKBOARD_DAYPLAN or "dayplan"

local function empty_day() return { blocks = {}, ranked = {}, later = {}, inputs = {} } end

-- The plan as the Worker has it. proposal is copied, so undoing hunks here
-- changes only what will be accepted.
local doc
local day = empty_day()
local proposal
local asked = {}
local projects = {}
local problem -- why there's no plan to show: no bridge, not signed in
local selected
local show_later = false
local plan_buf, diff_buf, goals_buf, priority_buf
-- Line number -> block id in the plan; -> hunk index in the diff; -> goal
-- id; -> index in the ranked list.
local line_block, line_hunk, hunk_lines, line_goal, line_rank = {}, {}, {}, {}, {}
local selected_rank = 1
local selected_hunk = 1
-- The goals, as the Worker reads them out of Pepper's goal notes (goals.ts),
-- and the one selected in agent://plan/goals.
local goals = {}
local selected_goal

-- 9:30am, as the plan shows times. hhmm is 24-hour, for the calendar.
local function hhmm(m) return string.format("%02d:%02d", math.floor(m / 60), m % 60) end
local function clock(m)
  local h = math.floor(m / 60) % 24
  return string.format("%d:%02d%s", (h + 11) % 12 + 1, m % 60, h < 12 and "am" or "pm")
end

local function length(m)
  local h, rest = math.floor(m / 60), m % 60
  if h == 0 then return rest .. "m" end
  return rest == 0 and (h .. "h") or string.format("%dh%02d", h, rest)
end

-- Minutes since the midnight that began this_day(), so past 1440 before 4am.
local function now()
  local d = os.date("*t")
  return d.hour * 60 + d.min + (d.hour < DAY_STARTS_HOUR and 24 * 60 or 0)
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
    "written to the Claude calendar with dayplan apply, which opens the gate",
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
    date = os.date("%a %d %b", os.time() - DAY_STARTS_HOUR * 3600),
    now = now(),
    problem = problem,
    projects = projects,
    blocks = day.blocks,
    selected = selected,
    ranked = day.ranked,
    later = show_later and day.later or nil,
    later_count = #day.later,
    inputs = day.inputs,
    focus = length(focus),
    fixed = fixed,
    proposal = proposal ~= nil,
    rank = selected_rank,
  }
end

local function goals_state()
  return { goals = goals, selected = selected_goal }
end

local function diff_state()
  local lines, hunks = diff()
  return {
    date = os.date("%a %d %b"),
    from = clock(proposal.from),
    projects = projects,
    reasons = proposal.reasons,
    lines = vim.tbl_map(function(l)
      return {
        op = l.op, hunk = l.hunk, id = l.block.id, start = l.block.start, stop = l.block.stop,
        title = l.block.title, kind = l.block.kind, project = l.block.project, card = l.block.card, board = l.block.board,
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
  corkboard.notify("corkboard.plan_goals", goals_state())
  -- For Pepper's band and status line (corkboard.live).
  require("corkboard.live").set("plan", {
    date = today(),
    problem = problem,
    proposal = proposal ~= nil,
    blocks = vim.tbl_map(function(b)
      return { start = b.start, stop = b.stop, title = b.title, kind = b.kind, card = b.card }
    end, day.blocks),
  })
end

-- Text under the HTML --------------------------------------------------------------

local function pin_of(b)
  return b.kind == "fixed" and "◇" or b.kind == "off" and "·" or "●"
end

local function render_plan()
  if not (plan_buf and vim.api.nvim_buf_is_valid(plan_buf)) then return end
  local lines, map = { "Day plan  " .. os.date("%a %d %b"), "" }, {}
  if problem then table.insert(lines, "  " .. problem) end
  if not problem and #day.blocks == 0 and not proposal then
    table.insert(lines, "  no plan yet: Pepper proposes one (plan_propose), and it shows here")
  end
  for _, b in ipairs(day.blocks) do
    table.insert(lines, string.format("  %7s–%-7s  %s %-48s %s%s", clock(b.start), clock(b.stop), pin_of(b), b.title,
      b.tag or "", b.pinned and "  pinned" or ""))
    map[#lines] = b.id
  end
  pinned.set_lines(plan_buf, lines)
  line_block = map
  pinned.follow(plan_buf, line_block, selected)
end

local function render_priority()
  if not (priority_buf and vim.api.nvim_buf_is_valid(priority_buf)) then return end
  local lines, map = { "Priority", "" }, {}
  for i, r in ipairs(day.ranked) do
    table.insert(lines, string.format("  %d. %-40s %5s", i, r.title, r.est))
    map[#lines] = i
    table.insert(lines, "     " .. r.why)
  end
  table.insert(lines, "")
  table.insert(lines, string.format("NOT TODAY (%d)%s", #day.later, show_later and "" or "  z to show"))
  if show_later then
    for _, l in ipairs(day.later) do table.insert(lines, "  " .. l.title .. "  " .. l.why) end
  end
  pinned.set_lines(priority_buf, lines)
  line_rank = map
  selected_rank = math.min(selected_rank, math.max(#day.ranked, 1))
end

local function render_diff()
  if not (proposal and diff_buf and vim.api.nvim_buf_is_valid(diff_buf)) then return end
  local lines, hunks = diff()
  local text = { "Re-plan of " .. os.date("%a %d %b") .. " from " .. clock(proposal.from), "" }
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
    table.insert(text, string.format("%s %7s–%-7s  %s %-44s %s", l.op, clock(b.start), clock(b.stop), pin_of(b), b.title,
      l.was and ("was " .. clock(l.was.start)) or ""))
    if l.hunk then map[#text] = l.hunk end
  end
  if #hunks == 0 then table.insert(text, "  no changes left: q keeps the plan as it is") end
  pinned.set_lines(diff_buf, text)
  line_hunk, hunk_lines = map, heads
  selected_hunk = math.min(selected_hunk, math.max(#hunks, 1))
end

local function render_goals()
  if not (goals_buf and vim.api.nvim_buf_is_valid(goals_buf)) then return end
  local lines, map = { "Goals", "" }, {}
  if #goals == 0 then table.insert(lines, "  no goals yet: Pepper keeps them as goal notes") end
  for _, g in ipairs(goals) do
    table.insert(lines, "  " .. g.name)
    map[#lines] = g.id
    if g.aim ~= "" then table.insert(lines, "    " .. g.aim) end
    if g.why ~= "" then table.insert(lines, "    why: " .. g.why) end
    for _, m in ipairs(g.measures) do table.insert(lines, "    measured by: " .. m) end
    for _, w in ipairs(g.week) do table.insert(lines, "    this week: " .. w) end
    table.insert(lines, "")
  end
  pinned.set_lines(goals_buf, lines)
  line_goal = map
  if not selected_goal or not pinned.line_of(line_goal, selected_goal) then selected_goal = goals[1] and goals[1].id end
  pinned.follow(goals_buf, line_goal, selected_goal)
end

local function redraw()
  render_plan()
  render_priority()
  render_diff()
  render_goals()
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

-- Close a view's tab (its window, when it shares one), the proposal's, and
-- go back to the plan.
local function close_view(buf)
  if buf and vim.api.nvim_buf_is_valid(buf) then
    for _, win in ipairs(vim.fn.win_findbuf(buf)) do
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

-- A block's card. In a project's window, on its board. The day plan's
-- window has no board, so it opens the card's project in a window of its
-- own (corkboard.open), or the one it has, and the card on its board there.
local function open_card(id, board)
  if not id then return vim.notify("corkboard: this block has no card") end
  if require("corkboard").window ~= "plan" then return require("corkboard.board").reveal(id) end
  local ok, boards = pcall(cloud().call, "plan_boards")
  local root
  for _, b in ipairs(ok and boards or {}) do
    if b.key == board and b.root ~= vim.NIL then root = b.root end
  end
  if not root then return vim.notify("corkboard: " .. id .. " is on a board with no project to open (" .. tostring(board) .. ")") end
  require("corkboard").notify("corkboard.open", { cwd = root, run = { "corkboard.board", "reveal", id } })
end

-- The re-plan waiting to be accepted. The assistant makes them; S tells it
-- what to change.
function M.replan()
  if not proposal then
    return vim.notify("corkboard: no re-plan is waiting. Pepper proposes them; S on a re-plan says what to change.")
  end
  show_buf(M.diff_buffer())
  redraw()
  local head = pinned.line_of(hunk_lines, selected_hunk)
  if head then vim.api.nvim_win_set_cursor(0, { head, 0 }) end
end

-- dayplan apply's blocks: what's still ahead and isn't already a calendar
-- event, as local times on doc.date.
local function calendar_blocks(blocks)
  local at = function(m) return doc.date .. "T" .. (m >= 24 * 60 and "23:59" or hhmm(m)) end
  -- What's past is only past today; another day's plan is written whole.
  local from = doc.date == this_day() and now() or 0
  local out = {}
  for _, b in ipairs(blocks) do
    if b.kind ~= "fixed" and b.stop > from then
      table.insert(out, { title = b.title, desc = b.desc or "", start = at(math.max(b.start, from)), ["end"] = at(b.stop) })
    end
  end
  return out
end

-- An answer from the Worker: { plan } or { conflict = the plan as it is }.
local function settle(res, what)
  if res.conflict then
    M.apply(res.conflict)
    vim.notify("corkboard: the plan changed before " .. what .. "; look at it again", vim.log.levels.WARN)
    return false
  end
  M.apply(res.plan)
  return true
end

-- The calendar first, then the Worker: a plan is only accepted once it's
-- on the calendar, which is what opens the dayplan gate.
function M.accept()
  if not (proposal and doc) then return end
  local blocks, version = vim.deepcopy(proposal.blocks), doc.version
  -- Accepting approves the day, which opens the dayplan gate; an empty plan
  -- would open it with nothing planned.
  if #blocks == 0 then return vim.notify("corkboard: nothing is left to accept; q keeps the plan as it was", vim.log.levels.WARN) end
  local input = vim.json.encode({ blocks = calendar_blocks(blocks), approve = true })
  vim.notify("corkboard: writing the plan to the calendar…")
  vim.system({ DAYPLAN, "apply" }, { stdin = input, text = true }, vim.schedule_wrap(function(r)
    if r.code ~= 0 then
      return vim.notify("corkboard: dayplan apply failed, so the plan isn't accepted: " .. vim.trim(r.stderr ~= "" and r.stderr or r.stdout), vim.log.levels.ERROR)
    end
    local ok, res = pcall(cloud().call, "plan_accept", doc.date, version, blocks)
    if not ok then
      return vim.notify("corkboard: on the calendar, but the Worker didn't take it: " .. res .. "; accept again", vim.log.levels.ERROR)
    end
    if settle(res, "it was accepted") then
      close_view(diff_buf)
      vim.notify("corkboard: plan accepted. " .. vim.trim(r.stdout))
    end
  end))
end

function M.discard()
  if not (proposal and doc) then return end
  if settle(cloud().call("plan_discard", doc.date, doc.version), "it was discarded") then close_view(diff_buf) end
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

-- What to change, for the assistant's next re-plan (it reads it with
-- plan_read).
function M.say()
  if not doc then return end
  vim.ui.input({ prompt = "Change the plan: " }, function(text)
    if not (text and vim.trim(text) ~= "") then return end
    settle(cloud().call("plan_say", doc.date, vim.trim(text)), "that was said")
  end)
end

-- The day, after an edit here: written back by version.
local function save_day()
  if doc then settle(cloud().call("plan_day", doc.date, doc.version, day.blocks), "the edit") end
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
    save_day()
  end)
end

-- A pinned block stays put when the day is re-planned.
function M.pin()
  local b = selected_block()
  if not b or b.kind ~= "work" then return end
  b.pinned = not b.pinned or nil
  save_day()
end

function M.toggle_later()
  show_later = not show_later
  redraw()
end

-- Read the plan again, and follow it from now on.
local following = false

-- The goals, read again. They change only when Pepper rewrites a goal note,
-- which nothing tells of: read with the plan, and on opening them.
local function load_goals()
  local ok, res = pcall(cloud().call, "goals")
  if ok and type(res) == "table" then goals = res end
end

function M.load()
  if not cloud().enabled() then
    problem = "the day plan needs corkboard's bridge and the cloud"
    return redraw()
  end
  load_goals()
  local ok, res = pcall(function()
    if not following then
      cloud().call("plan_subscribe")
      following = true
    end
    return cloud().call("plan_get", today())
  end)
  if not ok then
    problem = tostring(res)
    return redraw()
  end
  -- Read again on purpose (R): the proposal as the Worker has it, without
  -- the hunks undone here.
  proposal = nil
  M.apply(res)
end

-- The Worker's plan becomes what's shown. A new version replaces any hunks
-- undone here.
function M.apply(plan)
  if plan.date ~= today() then return end
  if doc and plan.version < doc.version then return end
  local was = doc and doc.version
  doc, problem = plan, nil
  day = vim.tbl_extend("force", empty_day(), plan.day or {})
  projects = plan.projects or {}
  asked = plan.asked or {}
  if plan.proposal and plan.proposal ~= vim.NIL then
    if was ~= plan.version or not proposal then
      proposal = vim.deepcopy(plan.proposal)
      proposal.why = type(proposal.why) == "table" and proposal.why or {}
      selected_hunk = 1
    end
  else
    proposal = nil
  end
  if not find(day.blocks, selected) then selected = current_block() end
  redraw()
end

-- What the page is sent, for tests.
function M.state() return plan_state(), proposal and diff_state() or nil end

-- From the bridge: the user's socket.
function M.cloud_event(event)
  if event.type == "plan" then M.apply(event.plan) end
  if event.type == "reconnected" then M.load() end
end

M.reset = M.load

-- The goals' window, on goal id (or the one last seen), read again.
function M.goals(id)
  load_goals()
  M.ensure()
  M.arrange()
  show_buf(M.goals_buffer())
  if id then selected_goal = id end
  redraw()
  local lnum = pinned.line_of(line_goal, selected_goal)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
end

local PLAN_ACTIONS = {
  replan = M.replan,
  edit = M.edit,
  pin = M.pin,
  later = M.toggle_later,
  goals = function() M.goals() end,
  claude = function() require("corkboard.plan.claude").open() end,
  open = function()
    local b = selected_block() or {}
    open_card(b.card, b.board)
  end,
  reset = M.load,
}

local GOAL_ACTIONS = {
  back = function() M.show() end,
  claude = PLAN_ACTIONS.claude,
  reset = function()
    load_goals()
    redraw()
  end,
}

local function selected_ranked() return day.ranked[selected_rank] or {} end

local PRIORITY_ACTIONS = {
  back = function() M.show() end,
  later = M.toggle_later,
  claude = PLAN_ACTIONS.claude,
  open = function()
    local b = find(day.blocks, selected_ranked().block) or {}
    open_card(b.card, b.board)
  end,
  reset = M.load,
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
      if l.hunk == selected_hunk and l.card then return open_card(l.card, l.board) end
    end
    open_card(nil)
  end,
}

-- A key hint or double-click in the browser.
function M.action(view, name, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local actions = { ["plan-diff"] = DIFF_ACTIONS, ["plan-goals"] = GOAL_ACTIONS, ["plan-priority"] = PRIORITY_ACTIONS }
  local fn = (actions[view] or PLAN_ACTIONS)[name]
  if fn then fn() end
end

-- A click on a ranked item in the browser.
function M.select_rank(i, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local lnum = pinned.line_of(line_rank, i)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
end

-- A click on a goal in the browser: from another window, it goes to the
-- goals'.
function M.select_goal(id, win)
  if win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  if vim.api.nvim_get_current_buf() ~= goals_buf then return M.goals(id) end
  local lnum = pinned.line_of(line_goal, id)
  if lnum then vim.api.nvim_win_set_cursor(0, { lnum, 2 }) end
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
    g = { "goals", "see the goals" },
    c = { "claude", "go to Pepper, beside the plan" },
    ["<CR>"] = { "open", "open the block's card" },
    R = { "reset", "read the plan again" },
  })
  k.j = { step(1), "next block" }
  k.k = { step(-1), "previous block" }

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

function M.goals_buffer()
  if goals_buf and vim.api.nvim_buf_is_valid(goals_buf) then return goals_buf end
  local step = function(dir) return function() pinned.step(line_goal, dir) end end
  local k = keys(GOAL_ACTIONS, {
    q = { "back", "back to the day" },
    c = { "claude", "go to Pepper, beside the plan" },
    R = { "reset", "read the goals again" },
  })
  k.j = { step(1), "next goal" }
  k.k = { step(-1), "previous goal" }

  goals_buf = pinned.listing("agent://plan/goals", "plan-goals", k, function() return line_goal end, function(id)
    if id == selected_goal then return end
    selected_goal = id
    notify_page()
  end)
  vim.bo[goals_buf].bufhidden = "hide"
  return goals_buf
end

function M.priority_buffer()
  if priority_buf and vim.api.nvim_buf_is_valid(priority_buf) then return priority_buf end
  local step = function(dir) return function() pinned.step(line_rank, dir) end end
  local k = keys(PRIORITY_ACTIONS, {
    q = { "back", "back to the day" },
    z = { "later", "show what's not today" },
    c = { "claude", "go to Pepper, beside the plan" },
    ["<CR>"] = { "open", "open the item's card" },
    R = { "reset", "read the plan again" },
  })
  k.j = { step(1), "next item" }
  k.k = { step(-1), "previous item" }

  priority_buf = pinned.listing("agent://plan/priority", "plan-priority", k, function() return line_rank end, function(i)
    if i == selected_rank then return end
    selected_rank = i
    -- The item's block is the day's selection too.
    local r = day.ranked[i]
    if r and r.block and find(day.blocks, r.block) then
      selected = r.block
      pinned.follow(plan_buf, line_block, selected)
    end
    notify_page()
  end)
  vim.bo[priority_buf].bufhidden = "hide"
  return priority_buf
end

-- Whether buf is one of the plan's tab's three.
function M.owns(buf) return buf == plan_buf or buf == goals_buf or buf == priority_buf end

-- The goals' window left of the day, and the priority's under it, wherever
-- the day's window is, unless they're already in that tab. Leaves focus
-- where it was.
local COLUMN_WIDTH = 52
function M.arrange()
  local plan_win = vim.fn.win_findbuf(M.buffer())[1]
  if not plan_win then return end
  local tab = vim.api.nvim_win_get_tabpage(plan_win)
  local from = vim.api.nvim_get_current_win()
  local function in_tab(buf)
    for _, w in ipairs(vim.fn.win_findbuf(buf)) do
      if vim.api.nvim_win_get_tabpage(w) == tab then return w end
    end
  end
  -- Each from the window it goes beside: the day's, or the other one's.
  local function open(buf, from_win, cmd)
    vim.api.nvim_set_current_win(from_win)
    vim.cmd(cmd)
    vim.api.nvim_win_set_buf(0, buf)
    vim.wo.winfixwidth = true
    return vim.api.nvim_get_current_win()
  end
  local goals_win, priority_win = in_tab(M.goals_buffer()), in_tab(M.priority_buffer())
  if not goals_win then
    goals_win = priority_win and open(goals_buf, priority_win, "leftabove split") or open(goals_buf, plan_win, "leftabove vsplit")
  end
  if not priority_win then open(priority_buf, goals_win, "rightbelow split") end
  vim.api.nvim_win_set_width(goals_win, COLUMN_WIDTH)
  if vim.api.nvim_win_is_valid(from) then vim.api.nvim_set_current_win(from) end
end

-- In the day plan's window (corkboard.window == "plan"), keep the plan its
-- first tab. Leaves focus where it was.
function M.ensure()
  if pinned.ensure("corkboard_plan", 1, M.buffer()) then
    M.arrange()
    M.load()
    -- The window opens with Pepper beside the plan, focus on the plan.
    -- CORKBOARD_PLAN_CLAUDE=0 leaves it out (tests).
    if vim.env.CORKBOARD_PLAN_CLAUDE == "0" then return end
    vim.schedule(function()
      local plan_win = vim.fn.win_findbuf(M.buffer())[1]
      if not plan_win then return end
      vim.api.nvim_set_current_win(plan_win)
      require("corkboard.plan.claude").open()
      if vim.api.nvim_win_is_valid(plan_win) then vim.api.nvim_set_current_win(plan_win) end
    end)
  end
end

-- The plan's tab, in the day plan's window. Elsewhere, <leader>p and
-- :AgentPlan open that window instead (corkboard.open_plan).
function M.show()
  M.ensure()
  pinned.show("corkboard_plan", 1, M.buffer())
  redraw()
end

-- For a channel that just attached: the last state again, if the view exists.
function M.push_all()
  if (plan_buf and vim.api.nvim_buf_is_valid(plan_buf)) or (goals_buf and vim.api.nvim_buf_is_valid(goals_buf)) then notify_page() end
end

return M
