-- Soft cost limits on the agents corkboard starts, in dollars, checked each
-- time the board is pushed:
--
--   g:corkboard_budget_card   what one card's sessions may cost in all
--   g:corkboard_budget_day    what all sessions started today may cost
--   g:corkboard_budget_block  also hold the agent (default false)
--
-- Unset is no limit. Passing a limit sets the card's attention, which raises
-- a notification, once: over_budget records which limit was passed
-- ("card:5", "day:2026-10-24"). With block, budget_hold is set too, and
-- mcp/board.ts refuses the agent's work on the card until the user answers.

local M = {}

local function board() return require("corkboard.board") end

local function dollars(n) return string.format("$%.2f", n) end

-- Flag a card that passed a limit, unless it has passed this one already.
local function flag(card, mark, message)
  card = board().get(card.id) -- earlier flags in this check changed the files
  if card.over_budget == mark then return end
  local fields = { over_budget = mark, attention = message }
  if vim.g.corkboard_budget_block then
    fields.budget_hold = message
    fields.agent_state = "blocked"
  end
  board().set(card.id, fields)
  board().log(card.id, "corkboard", message .. (vim.g.corkboard_budget_block and "; the agent is held until you answer" or ""))
end

-- Flagging writes the card, which pushes the board, which checks again.
local checking = false

-- costs: corkboard.usage's card_costs().
function M.check(cards, costs)
  if checking then return end
  local per_card, per_day = tonumber(vim.g.corkboard_budget_card), tonumber(vim.g.corkboard_budget_day)
  if not (per_card or per_day) or vim.tbl_isempty(costs) then return end
  checking = true
  local ok, err = pcall(M.check_now, cards, costs, per_card, per_day)
  checking = false
  if not ok then vim.notify("corkboard: budget check: " .. tostring(err), vim.log.levels.ERROR) end
end

function M.check_now(cards, costs, per_card, per_day)
  if per_card then
    for _, card in ipairs(cards) do
      local c = costs[card.id]
      if c and c.cost and c.cost >= per_card and card.status ~= "done" then
        flag(card, "card:" .. per_card, string.format("over budget: %s of the %s card limit", dollars(c.cost), dollars(per_card)))
      end
    end
  end

  if per_day then
    local today = 0
    for _, c in pairs(costs) do today = today + c.today end
    if today >= per_day then
      -- Only the cards still being worked on: those with a session running.
      local agents = require("corkboard.agents")
      for _, card in ipairs(cards) do
        if agents.session(card.id) then
          flag(card, "day:" .. os.date("%Y-%m-%d"), string.format("daily budget reached: %s of %s today", dollars(today), dollars(per_day)))
        end
      end
    end
  end
end

return M
