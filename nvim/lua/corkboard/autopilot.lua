-- The board run by Claude (Settings > Autopilot), so the user writes a
-- sentence and reads a summary and little in between:
--
--   intake     a new card's text, as typed, is written up by Claude: a
--              title, a description that says when it's done, a priority
--              and dependencies, split into several cards when it is
--              several tasks, and moved to ready when it's clear enough
--              to start (with a question as its attention when not)
--   autopilot  a ready card nobody has is handed to an agent
--   groomer    once the board has changed and settled, Claude reads the
--              open cards and fixes priorities, missing dependencies,
--              bare descriptions and duplicates, and moves what's clear to
--              ready; each change is logged on its card, and
--              :AgentUndoGroom puts the last run's back. Done cards are
--              archived after a while.
--   reviewer   a card submitted for review is reviewed by Claude in its
--              worktree (it may run the tests) before the user sees it:
--              problems send it back to its agent, up to a number of
--              rounds; otherwise the card gets a summary and a risk, and a
--              low-risk one can merge by itself
--
-- Each thinks with `claude -p` on the machine's own login, as propose.ts
-- does. The reviews are kept in the board's reviews.json, by card, against
-- the commit they reviewed.

local cards = require("corkboard.cards")
local util = require("corkboard.util")

local M = {}

local function board() return require("corkboard.board") end

local function on(name, default)
  local v = vim.g["corkboard_" .. name]
  if v == nil then return default end
  return v == true
end

-- claude -p; done(answer as schema's JSON) or done(nil, why). opts.tools:
-- the tools it may use (none otherwise), opts.cwd, opts.model.
local function think(system, input, schema, opts, done)
  if vim.fn.executable("claude") == 0 then return done(nil, "claude is not on PATH") end
  local tools = opts.tools or ""
  local args = {
    "claude", "-p", "--model", opts.model or vim.g.corkboard_planner_model or "sonnet",
    "--tools", tools, "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
    "--output-format", "json", "--system-prompt", system, "--json-schema", vim.json.encode(schema),
  }
  if tools ~= "" then vim.list_extend(args, { "--allowedTools", tools }) end
  local ok, err = pcall(vim.system, args, { stdin = input, cwd = opts.cwd, text = true, timeout = opts.timeout or 5 * 60000 },
    vim.schedule_wrap(function(r)
      local parsed, j = pcall(vim.json.decode, r.stdout or "", { luanil = { object = true, array = true } })
      if parsed and type(j) == "table" and not j.is_error and type(j.structured_output) == "table" then
        return done(j.structured_output)
      end
      local why = parsed and type(j) == "table" and (j.result or j.subtype)
        or vim.trim(r.stderr or ""):match("[^\n]*$")
      done(nil, (why and why ~= "") and why or ("exit " .. tostring(r.code)))
    end))
  if not ok then done(nil, tostring(err)) end
end

-- The open cards, for Claude to read beside what it's asked.
local function listing(list)
  local out = {}
  for _, c in ipairs(list) do
    if c.status ~= "done" then
      local description = cards.section(c, "DESCRIPTION")
      if #description > 600 then description = description:sub(1, 600) .. "…" end
      table.insert(out, string.format("## %s [%s, %s priority%s%s]\n%s\n%s", c.id, c.status, c.priority or "medium",
        #(c.dependencies or {}) > 0 and (", depends on " .. table.concat(c.dependencies, " ")) or "",
        c.agent_state and (", agent " .. c.agent_state) or "",
        c.title, description))
    end
  end
  return #out > 0 and table.concat(out, "\n\n") or "(no open cards)"
end

local function exists(list, id)
  for _, c in ipairs(list) do
    if c.id == id then return c end
  end
end

-- Whether id's dependencies reach target, which would make adding target
-- -> id a cycle.
local function reaches(list, id, target, seen)
  if id == target then return true end
  seen = seen or {}
  if seen[id] then return false end
  seen[id] = true
  local c = exists(list, id)
  for _, dep in ipairs(c and c.dependencies or {}) do
    if reaches(list, dep, target, seen) then return true end
  end
  return false
end

-- Intake ----------------------------------------------------------------------------

local writing = {} -- card id -> true while its text is being written up

local INTAKE = [[
You run a software project's kanban board. The user typed a line or a paragraph for a new card; write it up.
Usually it is one card. Split it only when it plainly holds separate tasks that could each be done and reviewed by
themselves; never more than 6.
For each card:
- title: one line, imperative, under 70 characters.
- description: markdown, short. What to do and why, in the user's terms, then "Done when:" and a few bullets an
  agent can check. Don't invent requirements the user didn't imply; say what you assumed.
- priority: high only when the text says it's urgent or it blocks other work; low when it's a nice-to-have.
  Otherwise medium.
- dependencies: ids of existing open cards that must be done first. after: 1-based positions of earlier cards
  in your own list that must be done first.
- ready: true when an agent could start now without asking anything. Otherwise false, and question: the one
  thing the user must decide or say, as a short question. question is "" when ready.]]

local INTAKE_SCHEMA = {
  type = "object",
  additionalProperties = false,
  required = { "cards" },
  properties = {
    cards = {
      type = "array",
      minItems = 1,
      items = {
        type = "object",
        additionalProperties = false,
        required = { "title", "description", "priority", "dependencies", "after", "ready", "question" },
        properties = {
          title = { type = "string" },
          description = { type = "string" },
          priority = { type = "string", enum = cards.priorities },
          dependencies = { type = "array", items = { type = "string" } },
          after = { type = "array", items = { type = "integer" } },
          ready = { type = "boolean" },
          question = { type = "string" },
        },
      },
    },
  },
}

function M.writing(id) return writing[id] end

-- Card id written up from text; any more cards it splits into go in status.
-- again: the card is being written again, so it stays one card.
local function write_up(id, text, status, again)
  writing[id] = true
  board().redraw()
  local list = cards.list()
  local input = again
      and ("# The board's open cards\n\n" .. listing(list) .. "\n\n# Card " .. id
        .. ", to write again as exactly one card now that the user answered its question\n\n" .. text)
    or ("# The board's open cards\n\n" .. listing(list) .. "\n\n# The user typed\n\n" .. text)
  think(INTAKE, input, INTAKE_SCHEMA, {},
    function(out, err)
      writing[id] = nil
      if not out then
        pcall(board().log, id, "planner", "could not write this card up: " .. err)
        return board().push()
      end
      if again then out.cards = { out.cards[1] } end
      local made = {}
      for i, c in ipairs(out.cards) do
        made[i] = i == 1 and id or cards.create(vim.trim(c.title), status)
      end
      for i, c in ipairs(out.cards) do
        local deps = {}
        for _, dep in ipairs(c.dependencies or {}) do
          dep = dep:upper()
          if exists(list, dep) and dep ~= made[i] then table.insert(deps, dep) end
        end
        for _, n in ipairs(c.after or {}) do
          if made[n] and n < i then table.insert(deps, made[n]) end
        end
        pcall(cards.change, made[i], function(card)
          card.title = vim.trim(c.title):gsub("\n", " ")
          cards.set_description(card, c.description or "")
          card.priority = c.priority ~= "medium" and c.priority or nil
          card.dependencies = deps
          if card.status == "backlog" and c.ready then card.status = "ready" end
          if not c.ready and vim.trim(c.question or "") ~= "" then card.attention = vim.trim(c.question) end
          cards.append_log(card, "planner", i == 1 and ("written up from: " .. text)
            or ("split from " .. id .. ": " .. text))
        end)
      end
      board().push()
    end)
end

-- A card from what the user typed, at once with the text as its title, and
-- written up when Claude answers. Its id.
function M.intake(text, status)
  text = vim.trim(text)
  local first = text:match("^[^\n]*")
  local id = board().create(#first > 80 and (first:sub(1, 77) .. "…") or first, status)
  if on("ai_intake", true) then write_up(id, text, status or "backlog") end
  return id
end

-- The user's answer to the question on a card nobody is working on: kept in
-- its description, and the card written up again with it.
function M.answer(id, question, text)
  local card = cards.get(id)
  local description = cards.section(card, "DESCRIPTION")
  local qa = "**" .. question .. "**\n" .. vim.trim(text)
  cards.change(id, function(c)
    c.attention = nil
    cards.set_description(c, description ~= "" and (description .. "\n\n" .. qa) or qa)
  end)
  board().push()
  if not on("ai_intake", true) then return end
  write_up(id, card.title .. "\n\n" .. description .. "\n\n" .. qa, card.status, true)
end

-- Autopilot -------------------------------------------------------------------------

-- Hands each ready card nobody has to an agent; true when it handed any.
function M.dispatch(list)
  if not on("autopilot", false) then return false end
  local any = false
  for _, c in ipairs(list) do
    if c.status == "ready" and not c.agent and not c.agent_state and not c.attention and not writing[c.id] then
      pcall(cards.set, c.id, { agent = "claude", agent_state = "queued" })
      any = true
    end
  end
  return any
end

-- Groomer ---------------------------------------------------------------------------

local GROOM = [[
You groom a software project's kanban board while the user is away. Read the open cards and change only what
clearly helps; most runs change little or nothing. Each change you return:
- id: the card.
- priority: a new priority, or "" to leave it.
- dependencies: card ids this card must wait for (its whole list), or null to leave them. Add one only when the
  work truly can't start before the other is done.
- description: for a card whose description is empty, what to do and "Done when:" bullets, from its title and
  the cards around it; "" to leave it. Never rewrite one that has text.
- ready: true to move a backlog card an agent could start without asking anything to ready; false to move a
  ready card that is too vague back to backlog; null to leave it.
- duplicate_of: the id of an open card this one repeats, or "". The other one is kept.
- question: for a backlog card that can't be started without the user, the one short question to put to them,
  or "". Ask sparingly.
- reason: one short line on why, for the card's log.
Leave cards an agent is on (agent queued, working, blocked or needs-review) alone.]]

local GROOM_SCHEMA = {
  type = "object",
  additionalProperties = false,
  required = { "changes" },
  properties = {
    changes = {
      type = "array",
      items = {
        type = "object",
        additionalProperties = false,
        required = { "id", "priority", "dependencies", "description", "ready", "duplicate_of", "question", "reason" },
        properties = {
          id = { type = "string" },
          priority = { type = "string", enum = { "", "high", "medium", "low" } },
          dependencies = { type = { "array", "null" }, items = { type = "string" } },
          description = { type = "string" },
          ready = { type = { "boolean", "null" } },
          duplicate_of = { type = "string" },
          question = { type = "string" },
          reason = { type = "string" },
        },
      },
    },
  },
}

local BUSY = { queued = true, working = true, blocked = true, ["needs-review"] = true }

local grooming = false
local groom_timer
local groomed_sig -- the open cards as the last run left them
local groomed_at = 0
local undo = {} -- the last run's cards as they were: id -> fields

-- What the groomer reads, so it runs only when that changed.
local function signature(list)
  local parts = {}
  for _, c in ipairs(list) do
    if c.status ~= "done" then
      table.insert(parts, table.concat({ c.id, c.status, c.title, c.priority or "", table.concat(c.dependencies or {}, ","),
        c.agent_state or "", cards.section(c, "DESCRIPTION") }, "\31"))
    end
  end
  return table.concat(parts, "\30")
end

-- 'yyyy-mm-dd hh:mm', local time, as os.time.
local function stamp(s)
  local y, mo, d, h, mi = tostring(s or ""):match("^(%d+)%-(%d+)%-(%d+) (%d+):(%d+)")
  if not y then
    y, mo, d, h, mi = tostring(s or ""):match("^(%d+)%-(%d+)%-(%d+)T(%d+):(%d+)")
  end
  return y and os.time({ year = y, month = mo, day = d, hour = h, min = mi })
end

-- Done cards older than the setting go to the archive (cloud boards have one).
local function archive_done(list)
  local hours = tonumber(vim.g.corkboard_archive_done_hours or 24) or 0
  if hours <= 0 or not cards.cloud() then return end
  for _, c in ipairs(list) do
    local at = stamp(c.updated_date)
    if c.status == "done" and at and os.time() - at > hours * 3600 then pcall(cards.archive, c.id) end
  end
end

local function apply(list, changes)
  local before, changed = {}, {}
  local function keep(c)
    if before[c.id] then return end
    before[c.id] = {
      priority = c.priority or "",
      dependencies = vim.deepcopy(c.dependencies or {}),
      status = c.status,
      description = cards.section(c, "DESCRIPTION"),
      attention = c.attention or "",
    }
  end
  for _, ch in ipairs(changes) do
    local id = tostring(ch.id or ""):upper()
    local c = exists(list, id)
    if c and (c.status == "backlog" or c.status == "ready") and not BUSY[c.agent_state or ""] then
      local fields, what = {}, {}
      if ch.priority ~= "" and ch.priority ~= (c.priority or "medium") then
        fields.priority = ch.priority == "medium" and "" or ch.priority
        table.insert(what, "priority " .. ch.priority)
      end
      if type(ch.dependencies) == "table" then
        local deps = {}
        for _, dep in ipairs(ch.dependencies) do
          dep = tostring(dep):upper()
          if dep ~= id and exists(list, dep) and not reaches(list, dep, id) then table.insert(deps, dep) end
        end
        if table.concat(deps, ",") ~= table.concat(c.dependencies or {}, ",") then
          fields.dependencies = deps
          table.insert(what, #deps > 0 and ("waits on " .. table.concat(deps, ", ")) or "no dependencies")
        end
      end
      local description = vim.trim(ch.description or "")
      if description ~= "" and cards.section(c, "DESCRIPTION") == "" then
        fields.description = description
        table.insert(what, "description written")
      end
      if ch.ready == true and c.status == "backlog" and not c.attention then
        fields.status = "ready"
        table.insert(what, "ready")
      elseif ch.ready == false and c.status == "ready" and not c.agent_state then
        fields.status = "backlog"
        table.insert(what, "back to backlog")
      end
      local dup = tostring(ch.duplicate_of or ""):upper()
      if dup ~= "" and dup ~= id and exists(list, dup) and exists(list, dup).status ~= "done" then
        fields.status = "done"
        what = { "duplicate of " .. dup }
        pcall(cards.log, dup, "groomer", id .. " was a duplicate of this card")
      elseif vim.trim(ch.question or "") ~= "" and not c.attention and c.status == "backlog" then
        fields.attention = vim.trim(ch.question)
        table.insert(what, "asked: " .. fields.attention)
      end
      if next(fields) then
        keep(c)
        local ok = pcall(cards.change, id, function(card)
          for k, v in pairs(fields) do
            if k == "description" then
              cards.set_description(card, v)
            else
              card[k] = v ~= "" and v or nil
            end
          end
          cards.append_log(card, "groomer", table.concat(what, "; ") .. (ch.reason ~= "" and (" — " .. ch.reason) or ""))
        end)
        if ok then table.insert(changed, id) end
      end
    end
  end
  return changed, before
end

function M.groom()
  if util.no_project() then return end
  if grooming then return end
  grooming = true
  local list = cards.list()
  archive_done(list)
  local sig = signature(list)
  think(GROOM, "# The board's open cards\n\n" .. listing(list), GROOM_SCHEMA, {}, function(out, err)
    grooming = false
    groomed_at = os.time()
    if not out then return vim.notify("corkboard: the groomer failed: " .. err, vim.log.levels.WARN) end
    -- What changed while it thought is read again, so it isn't undone.
    local now_list = cards.list()
    if signature(now_list) ~= sig then
      groomed_sig = nil
      return
    end
    local changed, before = apply(now_list, out.changes or {})
    if #changed > 0 then
      undo = before
      vim.notify("corkboard: the groomer changed " .. table.concat(changed, ", "))
    end
    board().push()
    groomed_sig = signature(cards.list())
  end)
end

-- Puts the last run's cards back as they were.
function M.undo_groom()
  local ids = vim.tbl_keys(undo)
  if #ids == 0 then return vim.notify("corkboard: nothing to undo") end
  for id, was in pairs(undo) do
    pcall(cards.change, id, function(card)
      card.priority = was.priority ~= "" and was.priority or nil
      card.dependencies = was.dependencies
      card.status = was.status
      card.attention = was.attention ~= "" and was.attention or nil
      cards.set_description(card, was.description)
      cards.append_log(card, "user", "undid the groomer's changes")
    end)
  end
  undo = {}
  table.sort(ids)
  vim.notify("corkboard: put back " .. table.concat(ids, ", "))
  board().push()
end

-- After the board changed: groom once it has been quiet for a while, and no
-- sooner than the setting's minutes after the last run.
local function maybe_groom(list)
  local minutes = tonumber(vim.g.corkboard_groom_minutes or 30) or 0
  if minutes <= 0 or grooming or signature(list) == groomed_sig then return end
  local wait = math.max(120, groomed_at + minutes * 60 - os.time())
  if groom_timer then groom_timer:stop() end
  groom_timer = vim.defer_fn(function()
    groom_timer = nil
    if signature(cards.list()) ~= groomed_sig then M.groom() end
  end, wait * 1000)
end

-- Reviewer --------------------------------------------------------------------------

local REVIEW = [[
You review an AI agent's work on a card before the user sees it. You are in the card's git worktree. Read the
card, the agent's log and the diff; read the code around it as you need, and run the project's tests or type
checks when there are any (look at package.json, Makefile, flake, README). Do not change any file.
passed: false only for real problems: the card's "Done when" not met, a bug, a failing test or build, work left
uncommitted, or something unsafe. Style alone never fails a review.
risk: low when the change is small, contained and checked; high when it touches data, security, money, migrations
or much shared code; otherwise medium.
summary: at most three short lines for the user: what changed, and how you know it works.
problems: each one specific, with file and line, for the agent to fix; [] when it passed.]]

local REVIEW_SCHEMA = {
  type = "object",
  additionalProperties = false,
  required = { "passed", "risk", "summary", "problems" },
  properties = {
    passed = { type = "boolean" },
    risk = { type = "string", enum = { "low", "medium", "high" } },
    summary = { type = "string" },
    problems = { type = "array", items = { type = "string" } },
  },
}

local reviews -- card id -> { sha, passed, risk, summary, problems, rounds }
local reviewing = {} -- card id -> true while its review runs
local heads = {} -- card id -> its worktree's commit, as the last push read it

local function reviews_file() return vim.fs.joinpath(board().dir(), "reviews.json") end

local function load()
  if reviews then return reviews end
  local ok, data = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(reviews_file()), "\n")) end)
  reviews = ok and type(data) == "table" and data or {}
  return reviews
end

local function save()
  vim.fn.mkdir(board().dir(), "p")
  pcall(vim.fn.writefile, { vim.json.encode(reviews) }, reviews_file())
end

-- Read on every push: only cards waiting for review, and a card's dates
-- are to the minute, too coarse to tell a resubmission by.
local function head(c)
  local ok, sha = util.git({ "rev-parse", "HEAD" }, c.worktree)
  local _, dirty = util.git({ "status", "--porcelain" }, c.worktree)
  sha = ok and (vim.trim(sha) .. (vim.trim(dirty) ~= "" and "+dirty" or "")) or nil
  heads[c.id] = sha
  return sha
end

-- What the board shows of a card's review: { state = "reviewing" }, or the
-- last one of its current commit.
function M.review(c)
  if reviewing[c.id] then return { state = "reviewing" } end
  local r, h = load()[c.id], heads[c.id]
  if not (r and c.status == "review" and h and r.sha == h) then return nil end
  return {
    state = r.error and "error" or (r.passed and "passed" or "failed"),
    risk = r.risk,
    summary = r.error or r.summary,
    problems = r.problems,
  }
end

-- For the review tab: the last review of the card, if any.
function M.last_review(id) return load()[id] end

local function send_back(c, r)
  local feedback = "The reviewer sent this card back:\n" .. table.concat(vim.tbl_map(function(p) return "- " .. p end, r.problems), "\n")
    .. "\nFix these, commit, then call submit_for_review again."
  local agents = require("corkboard.agents")
  -- Working, not queued, so the board's push doesn't start a second one.
  board().set(c.id, { status = "doing", agent_state = "working", attention = "" })
  if agents.session(c.id) then
    agents.tell(c.id, feedback)
  else
    agents.start(c.id, { feedback = feedback })
  end
end

local function start_review(c, sha)
  reviewing[c.id] = true
  local main = ""
  local root = util.repo_root(c.worktree)
  if root then
    local _, b = util.git({ "symbolic-ref", "--short", "HEAD" }, root)
    main = vim.trim(b)
  end
  local _, base = util.git({ "merge-base", main ~= "" and main or "HEAD", "HEAD" }, c.worktree)
  local _, diff = util.git({ "diff", vim.trim(base) }, c.worktree)
  if #diff > 150000 then diff = diff:sub(1, 150000) .. "\n… (cut; read the files for the rest)" end
  local notes = cards.section(c, "NOTES")
  if #notes > 4000 then notes = "…" .. notes:sub(-4000) end
  local input = table.concat({
    "# " .. c.id .. ": " .. c.title, "", cards.section(c, "DESCRIPTION"), "",
    "# The agent's log", "", notes, "",
    "# The diff against " .. (main ~= "" and main or "HEAD"), "", "```diff", diff, "```",
  }, "\n")
  board().redraw()
  think(REVIEW, input, REVIEW_SCHEMA, {
    tools = "Read,Grep,Glob,Bash",
    cwd = c.worktree,
    model = vim.g.corkboard_reviewer_model or "sonnet",
    timeout = 20 * 60000,
  }, function(out, err)
    reviewing[c.id] = nil
    local prev = load()[c.id] or {}
    if not out then
      board().log(c.id, "reviewer", "could not review: " .. err)
      reviews[c.id] = { sha = sha, error = "could not review: " .. err, problems = {}, rounds = prev.rounds or 0 }
      save()
      return board().push()
    end
    local passed = out.passed or #(out.problems or {}) == 0
    local r = {
      sha = sha,
      passed = passed,
      risk = out.risk,
      summary = vim.trim(out.summary or ""),
      problems = out.problems or {},
      -- Rounds sent back in a row.
      rounds = passed and 0 or (prev.rounds or 0) + 1,
    }
    reviews[c.id] = r
    save()
    local now = cards.get(c.id)
    board().log(c.id, "reviewer", (r.passed and ("passed, " .. r.risk .. " risk") or "sent back") .. "\n" .. r.summary
      .. (#r.problems > 0 and ("\n" .. table.concat(vim.tbl_map(function(p) return "- " .. p end, r.problems), "\n")) or ""))
    -- The user may have acted on it meanwhile.
    if now.status ~= "review" then return board().push() end
    if not r.passed then
      if r.rounds <= (tonumber(vim.g.corkboard_review_rounds or 2) or 2) then return send_back(now, r) end
      board().set(c.id, { attention = "the reviewer still finds problems after " .. (r.rounds - 1) .. " rounds" })
    elseif r.risk == "low" and on("auto_merge", false) then
      require("corkboard.review").approve(c.id, nil, { confirm = false })
    end
    board().push()
  end)
end

local function check_reviews(list)
  if not on("pre_review", true) then return end
  local running = vim.tbl_count(reviewing)
  for _, c in ipairs(list) do
    if running >= 2 then return end
    if c.status == "review" and c.agent_state == "needs-review" and not reviewing[c.id]
      and c.worktree and c.worktree ~= "" and vim.fn.isdirectory(c.worktree) == 1 then
      local sha = head(c)
      local r = load()[c.id]
      if sha and not (r and r.sha == sha) then
        running = running + 1
        vim.schedule(function() start_review(c, sha) end)
      end
    elseif c.status == "done" and load()[c.id] then
      reviews[c.id] = nil
      save()
    end
  end
end

-- Every board push: hand out ready cards, review what's submitted, and
-- groom once things settle. Only with the page attached, as agents do. True
-- when it changed cards, so the board reads them again.
function M.push(list)
  if not require("corkboard").attached() then return false end
  local handed = M.dispatch(list)
  check_reviews(list)
  maybe_groom(list)
  return handed
end

return M
