-- corkboard-ui's ask (hooks/ui-mcp.lua), for a kind without AskUserQuestion
-- (.agent/plans/agents.md, stage 4): its questions as a session's, so the
-- card's attention, the page's notification and away mode see them as they
-- see Claude Code's, and the answers back to the tool call that asked. The
-- server waits on them a while; one that comes later goes to the session as
-- its next prompt.
--
-- Questions are AskUserQuestion's: { question, header, multiSelect,
-- options = { { label, description } } }; answers away mode's: one
-- { picks = { 0-based }, other = "its own words" } for each.

local M = {}

local asks = {} -- id -> { buf, questions, answers, gone }
local open = {} -- buf -> id
local n = 0

local function agents() return require("corkboard.agents") end

-- The answers as words, which the tool returns and a late one is sent as.
function M.words(questions, answers)
  local out = {}
  for i, q in ipairs(questions) do
    local a = answers[i] or {}
    local said = {}
    for _, p in ipairs(a.picks or {}) do
      local o = (q.options or {})[p + 1]
      if o then table.insert(said, o.label) end
    end
    if type(a.other) == "string" and vim.trim(a.other) ~= "" then table.insert(said, vim.trim(a.other)) end
    table.insert(out, ("%s → %s"):format(q.question or q.header or ("question " .. i), #said > 0 and table.concat(said, ", ") or "(no answer)"))
  end
  return table.concat(out, "\n")
end

-- A new question of buf's session; its id, or nil and why.
function M.open(buf, questions)
  if not (buf and vim.api.nvim_buf_is_valid(buf) and vim.b[buf].corkboard_agent) then return nil, "no session to ask from" end
  if type(questions) ~= "table" or #questions == 0 then return nil, "ask at least one question" end
  for _, q in ipairs(questions) do
    if type(q) ~= "table" or type(q.question) ~= "string" then return nil, "each question needs its question" end
    q.options = type(q.options) == "table" and q.options or {}
  end
  if open[buf] then asks[open[buf]] = nil end
  n = n + 1
  local id = tostring(n)
  asks[id] = { buf = buf, questions = questions }
  open[buf] = id
  agents().hook({ buf = buf, event = "asking", tool_name = "ask", question = questions[1].question, questions = questions })
  return id
end

-- What the session is asking through ask, if it is: its questions.
function M.pending(buf)
  local id = open[buf]
  return id and asks[id].questions or nil
end

-- buf's answers, from away mode (away.lua's say) or here; nil and why when
-- they don't fit.
function M.answer(buf, answers)
  local id = open[buf]
  if not id then return nil, "it isn't asking" end
  local a = asks[id]
  if type(answers) ~= "table" or #answers ~= #a.questions then return nil, "answer each question" end
  for i, q in ipairs(a.questions) do
    local picks = type(answers[i]) == "table" and answers[i].picks or {}
    for _, p in ipairs(picks) do
      if type(p) ~= "number" or p < 0 or p >= #q.options then return nil, "no such option" end
    end
    if not q.multiSelect and #picks > 1 then return nil, "pick one: " .. (q.header or q.question) end
  end
  open[buf] = nil
  agents().hook({ buf = buf, event = "tool_done", tool_name = "ask" })
  if a.gone then
    -- The tool call stopped waiting: the session hears it as a prompt.
    asks[id] = nil
    local kind = require("corkboard.agent").of(buf)
    local text = "The answer to what you asked:\n" .. M.words(a.questions, answers)
    if kind and kind.prompt then return kind.prompt(buf, text) or true end
    local terminal = require("corkboard.terminal")
    if terminal.alive(buf) then vim.fn.chansend(terminal.job(buf), "\27[200~" .. text .. "\27[201~\r") end
    return true
  end
  a.answers = answers
  return true
end

-- The ask's answers as words once there are some; nil while it waits. The
-- server asks till it has them, or gives up (M.wait_over).
function M.result(id)
  local a = asks[id]
  if not a or not a.answers then return nil end
  asks[id] = nil
  return M.words(a.questions, a.answers)
end

-- The server stopped waiting: a later answer is sent as a prompt.
function M.wait_over(id)
  if asks[id] then asks[id].gone = true end
end

-- Answered here: each question in turn, as a pick from its options or its
-- own words, a choice of several as their numbers.
function M.prompt(buf)
  local questions = M.pending(buf)
  if not questions then return false end
  local answers = {}
  local function ask(i)
    local q = questions[i]
    if not q then
      local ok, why = M.answer(buf, answers)
      if not ok then vim.notify("corkboard: " .. why, vim.log.levels.WARN) end
      return
    end
    local function own(prompt, done)
      vim.ui.input({ prompt = prompt }, function(text)
        if text == nil then return end
        done(text)
      end)
    end
    if q.multiSelect or #q.options == 0 then
      local list = {}
      for j, o in ipairs(q.options) do
        table.insert(list, ("%d. %s"):format(j, o.label))
      end
      local prompt = q.question .. (#list > 0 and ("\n" .. table.concat(list, "\n") .. "\nNumbers, or your own words: ") or " ")
      return own(prompt, function(text)
        local picks = {}
        for d in text:gmatch("%d+") do
          local p = tonumber(d)
          if p >= 1 and p <= #q.options then table.insert(picks, p - 1) end
        end
        answers[i] = #picks > 0 and { picks = picks } or { picks = {}, other = text }
        ask(i + 1)
      end)
    end
    local items = vim.list_extend(vim.deepcopy(q.options), { { label = "Something else…", other = true } })
    vim.ui.select(items, {
      prompt = q.question,
      format_item = function(o) return o.label .. (o.description and ("  " .. o.description) or "") end,
    }, function(o, j)
      if not o then return end
      if o.other then
        return own(q.question .. " ", function(text)
          answers[i] = { picks = {}, other = text }
          ask(i + 1)
        end)
      end
      answers[i] = { picks = { j - 1 } }
      ask(i + 1)
    end)
  end
  ask(1)
  return true
end

return M
