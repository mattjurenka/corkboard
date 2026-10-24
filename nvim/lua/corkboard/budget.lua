-- Soft cost limits on the agents corkboard starts, in dollars, checked each
-- time the board is pushed:
--
--   g:corkboard_budget_card   what one card's sessions may cost in all
--   g:corkboard_budget_day    what all cards' sessions started today may
--   g:corkboard_budget_block  also hold the agent (default false)
--
-- Either unset is no limit. Passing one sets the card's attention, which
-- raises a desktop notification, once per limit: the card's over_budget
-- records which limit it passed ("card:5" or "day:2026-10-24"), so it isn't
-- raised again until the limit changes or another day begins. With block,
-- the card also gets budget_hold, and mcp/board.ts refuses the agent's work
-- on the card while it is set; answering the card (r) clears it.

local M = {}

local function board() return require("corkboard.board") end

local function dollars(n) return string.format("$%.2f", n) end

-- Flag a card that passed a limit, unless it has passed this one already.
local function flag(card, mark, message)
  card = board().get(card.id) -- the list being checked is from before earlier flags
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

function M.check(cards)
  if checking then return end
  local per_card, per_day = tonumber(vim.g.corkboard_budget_card), tonumber(vim.g.corkboard_budget_day)
  if not (per_card or per_day) then return end
  checking = true
  local ok, err = pcall(M.check_now, cards, per_card, per_day)
  checking = false
  if not ok then vim.notify("corkboard: budget check: " .. tostring(err), vim.log.levels.ERROR) end
end

function M.check_now(cards, per_card, per_day)
  local costs = require("corkboard.usage").card_costs()
  if vim.tbl_isempty(costs) then return end

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
      -- The cards still being worked on today: those with a session running.
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
