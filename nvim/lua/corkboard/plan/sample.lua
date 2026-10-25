-- Test data for the day plan (corkboard.plan), until it reads real projects
-- and a calendar: one day across four projects, and a re-plan of it after
-- the afternoon changes. Times are minutes since midnight.

local M = {}

-- color is a theme color the page has: accent, review, working, special.
M.projects = {
  { key = "cb", name = "corkboard", color = "accent" },
  { key = "site", name = "client site", color = "review" },
  { key = "lab", name = "homelab", color = "working" },
  { key = "life", name = "life", color = "special" },
}

local function t(h, m) return h * 60 + (m or 0) end

-- kind: work (a project's), fixed (a calendar event, not the planner's to
-- move) or off (sleep, meals, free time).
function M.day()
  return {
    blocks = {
      { id = "sleep", start = t(0), stop = t(7), title = "sleep", kind = "off" },
      { id = "wake", start = t(7), stop = t(7, 30), title = "wake · coffee · read the agents' overnight log", kind = "work", project = "life" },
      { id = "approve", start = t(7, 30), stop = t(8), title = "approve today's plan", kind = "work", project = "cb", tag = "plan" },
      { id = "task14", start = t(8), stop = t(10, 30), title = "TASK-14 bridge auth refresh", kind = "work", project = "cb", tag = "deep", card = "TASK-14" },
      { id = "review-am", start = t(10, 30), stop = t(11), title = "review TASK-9, TASK-11, TASK-12", kind = "work", project = "cb", tag = "review" },
      { id = "standup", start = t(11), stop = t(11, 30), title = "standup", kind = "fixed", tag = "calendar" },
      { id = "payment", start = t(11, 30), stop = t(12, 30), title = "checkout flow: payment step", kind = "work", project = "site", tag = "deep" },
      { id = "lunch", start = t(12, 30), stop = t(13, 30), title = "lunch · walk", kind = "off" },
      { id = "qa", start = t(13, 30), stop = t(15, 30), title = "checkout flow: error states + QA", kind = "work", project = "site", tag = "due Wed" },
      { id = "handoff", start = t(15, 30), stop = t(16), title = "hand off TASK-16, TASK-17 to agents", kind = "work", project = "cb", tag = "queue" },
      { id = "oneonone", start = t(16), stop = t(16, 30), title = "1:1 with client", kind = "fixed", tag = "calendar" },
      { id = "backups", start = t(16, 30), stop = t(17, 30), title = "homelab: verify restic backups", kind = "work", project = "lab", tag = "shallow" },
      { id = "review-pm", start = t(17, 30), stop = t(18), title = "review what the agents finished", kind = "work", project = "cb", tag = "review" },
      { id = "dinner", start = t(18), stop = t(19, 30), title = "dinner · off", kind = "off" },
      { id = "taxes", start = t(19, 30), stop = t(20, 30), title = "collect tax docs", kind = "work", project = "life", tag = "due Fri" },
      { id = "free", start = t(20, 30), stop = t(23), title = "free", kind = "off" },
      { id = "winddown", start = t(23), stop = t(24), title = "wind down", kind = "off" },
    },
    -- Across every project, most important first; block is where it went.
    ranked = {
      { title = "checkout flow (client site)", project = "site", est = "3h", why = "due Wed · client waiting · not agent-able", block = "qa" },
      { title = "TASK-14 bridge auth refresh", project = "cb", est = "2h30", why = "blocks 3 cards · best in peak hours", block = "task14" },
      { title = "review TASK-9 / 11 / 12", project = "cb", est = "30m", why = "agents idle until they're reviewed", block = "review-am" },
      { title = "hand off TASK-16, TASK-17", project = "cb", est = "15m", why = "agent-able · they run during your 1:1", block = "handoff" },
      { title = "collect tax docs", project = "life", est = "1h", why = "due Fri · an evening job, not focus", block = "taxes" },
      { title = "verify restic backups", project = "lab", est = "1h", why = "6 days overdue · shallow, fits the dip", block = "backups" },
      { title = "write the corkboard README", project = "cb", est = "1h", why = "no deadline · next free slot Tue" },
    },
    later = {
      { title = "site: newsletter signup copy", project = "site", why = "due in a week · Tue" },
      { title = "homelab: upgrade to NixOS 26.11", project = "lab", why = "2h, wants a weekend · Sat" },
      { title = "TASK-21 theme picker", project = "cb", why = "agent-able · when an agent is idle" },
      { title = "renew passport", project = "life", why = "due Dec · Thu" },
    },
    inputs = {
      { label = "calendar", value = "2 meetings, fixed" },
      { label = "agents", value = "2 running · 3 to review", tone = "working" },
      { label = "deadlines", value = "site checkout · Wed", tone = "review" },
      { label = "energy", value = "peak 08–12 · dip 15–17" },
      { label = "sleep", value = "23:00 → 07:00" },
    },
  }
end

-- The re-plan after lunch: the client moved the 1:1 forward and TASK-16's
-- agent finished early. Changes the planner made are the blocks with a why;
-- pinned blocks stay where they are.
function M.replan(blocks)
  local by_id, out = {}, {}
  for _, b in ipairs(blocks) do by_id[b.id] = b end
  local why = {}
  local function move(id, start, stop, reason)
    local b = by_id[id]
    if not b or b.pinned then return end
    by_id[id] = vim.tbl_extend("force", b, { start = start, stop = stop })
    why[id] = reason
  end
  local function add(b, reason)
    by_id[b.id] = b
    why[b.id] = reason
  end
  local function drop(id, reason)
    if not by_id[id] or by_id[id].pinned then return end
    by_id[id] = nil
    why[id] = reason
  end

  add({ id = "review16", start = t(13, 30), stop = t(14), title = "review TASK-16 (agent done early)", kind = "work", project = "cb", tag = "review", card = "TASK-16" },
    "TASK-16's agent finished; reviewing it now unblocks TASK-18 and TASK-19")
  move("oneonone", t(14), t(14, 30), "the client moved the 1:1 to 14:00")
  move("handoff", t(14, 30), t(15), "queue the agents before QA, so they run during it")
  move("qa", t(15), t(17), "QA stays one 2h block, after the 1:1; Wed keeps 1h of slack")
  drop("backups", "no room this afternoon; the full check goes to Tue")
  add({ id = "shutdown", start = t(17), stop = t(17, 30), title = "shutdown: pick tomorrow's top 3", kind = "work", project = "life", tag = "plan" },
    "the moved 1:1 freed half an hour before the review")
  add({ id = "snapshot", start = t(20, 30), stop = t(20, 45), title = "homelab: check last night's snapshot exists", kind = "work", project = "lab", tag = "15m" },
    "backups are 6 days overdue; a 15-minute check today, the full one Tue")
  move("free", t(20, 45), t(23), "after the snapshot check")

  for _, b in pairs(by_id) do table.insert(out, b) end
  table.sort(out, function(a, b) return a.start < b.start end)
  return {
    from = t(13, 5),
    reasons = {
      { text = "the client moved the 1:1 from 16:00 to 14:00", source = "calendar · 12:58" },
      { tone = "working", text = "TASK-16's agent finished early and is waiting on review", source = "corkboard · 12:41" },
      { tone = "blocked", text = "the backup check is 6 days overdue", source = "board" },
    },
    blocks = out,
    why = why,
  }
end

return M
