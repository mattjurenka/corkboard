-- Pepper, the personal assistant (~/pepper), in the day plan's window: a
-- Claude Code terminal beside the plan, running in pepper-vm
-- (~/nixosconfig/modules/hosts/pepper-vm) over pepper-vm-ssh. The VM sees
-- none of this machine's files and reaches only an allowlist of hosts; its
-- Claude Code login, and the settings and MCP servers it may use, are the
-- guest's own.
--
-- It plans with corkboard's MCP server (plan_read, plan_propose, notes), and
-- proposes rather than writing the calendar: the user accepts in the plan,
-- which writes it (corkboard.plan's accept).

local M = {}

local VIA = { "pepper-vm-ssh" }
-- Where the guest's corkboard MCP server looks for Pepper's token (its
-- pepper-corkboard-headers).
local TOKEN = "/var/lib/pepper/corkboard-token"

local PROMPT = [[
You are Pepper, Matt's personal assistant, a Claude Code session in corkboard's day plan window beside his plan for today.
You run in a VM of your own: none of Matt's files are here, and you reach only Anthropic, corkboard and Google.
When the user asks you to plan or re-plan the day, plan it as the plan-my-day skill would (if you have it), with one
change at its end: instead of writing the calendar, call corkboard's plan_propose with the blocks. The user sees it
in the plan beside you as a diff, undoes what they don't want, and accepts with A, which writes the calendar and
opens the gate; they may also say what to change, which plan_read returns as asked.
Read today's plan with plan_read first; keep the ids of blocks you don't change. Minutes since midnight.
Use corkboard's notes (notes_search, note_read, note_write, note_append) for what happened on earlier days, and for
Matt's goals: notes of kind goal, one per goal (why, how it's measured, this week's step). Only you see them;
no other agent can, so don't copy them into cards or other notes.
You don't do coding or project work yourself. When Matt asks for that kind of work, make a card for it on the
project's board (list_boards for its key) with create_card: status ready, a description a session that knows
nothing of this conversation can act on (what to do, why, and anything Matt told you about it), and attention
set to one line saying what it's for, so corkboard notifies him. He starts the agent from the card.
Then tell Matt the card's id and board.]]

-- A Pepper token, the only one that sees the goals (any other session that
-- logs in gets the rest of the notes, not them), written into the guest for
-- its corkboard MCP server; then done(cleanup), where cleanup takes it out
-- and revokes it. Without the bridge, or when the guest can't be written,
-- done(nil): Pepper uses the guest's own corkboard login, without goals.
local function hand_token(done)
  local cloud = require("corkboard.cards.cloud")
  local ok, grant = pcall(cloud.pepper_token)
  if not ok then
    vim.notify("corkboard: no token for Pepper, so no goals: " .. tostring(grant), vim.log.levels.WARN)
    return done(nil)
  end
  local function revoke() pcall(cloud.revoke, grant.token) end
  local write = vim.list_extend(vim.deepcopy(VIA), { "sh", "-c", "umask 077 && cat > " .. TOKEN })
  vim.system(write, { stdin = grant.token, text = true }, vim.schedule_wrap(function(res)
    if res.code ~= 0 then
      vim.notify("corkboard: couldn't give Pepper its token, so no goals: " .. vim.trim(res.stderr or ""), vim.log.levels.WARN)
      revoke()
      return done(nil)
    end
    done(function()
      vim.system(vim.list_extend(vim.deepcopy(VIA), { "rm", "-f", TOKEN }))
      revoke()
    end)
  end))
end

local buf, starting

function M.alive() return require("corkboard.terminal").alive(buf) end

-- Its share of the window's width, kept as the window resizes; dragging the
-- separator changes it, and from then on it's kept as dragged. Until then,
-- the plan keeps the width for its two columns (Plan.tsx: 96ch and its
-- margins) as long as Claude Code keeps its own.
local share, dragged = 0.4, false
local MIN, PLAN_MIN = 60, 100
local fitted, last_columns

-- Claude Code's window, when it's beside the plan and nothing else.
local function beside()
  local win = buf and vim.fn.win_findbuf(buf)[1]
  if not win then return end
  local wins = vim.api.nvim_tabpage_list_wins(vim.api.nvim_win_get_tabpage(win))
  if #wins ~= 2 or not vim.tbl_contains(wins, vim.fn.win_findbuf(require("corkboard.plan").buffer())[1]) then return end
  -- Side by side, not one above the other.
  local other = wins[1] == win and wins[2] or wins[1]
  if vim.api.nvim_win_get_width(win) + vim.api.nvim_win_get_width(other) + 1 ~= vim.o.columns then return end
  return win
end

local function fit()
  local win = beside()
  if not win then return end
  local cols = vim.o.columns
  local width = math.floor(cols * share + 0.5)
  if not dragged then
    width = math.min(width, cols - math.min(PLAN_MIN, math.floor(cols / 2)))
    width = math.max(width, math.min(MIN, math.floor(cols / 2)))
  end
  vim.wo[win].winfixwidth = true
  vim.api.nvim_win_set_width(win, width)
  fitted, last_columns = vim.api.nvim_win_get_width(win), cols
end

local group = vim.api.nvim_create_augroup("corkboard.plan.claude", {})
vim.api.nvim_create_autocmd("VimResized", { group = group, callback = fit })
-- A width it wasn't fitted to, in a window that didn't resize: the user's.
vim.api.nvim_create_autocmd("WinResized", {
  group = group,
  callback = function()
    local win = beside()
    if not win or not vim.tbl_contains(vim.v.event.windows, win) or vim.o.columns ~= last_columns then return end
    local width = vim.api.nvim_win_get_width(win)
    if width ~= fitted then share, dragged, fitted = width / vim.o.columns, true, width end
  end,
})

-- Open it to the right of the plan, or go to it if it's open. Starting
-- waits on the guest for its token (up to 90s for sshd on a cold boot), so a
-- second press meanwhile only says so.
function M.open()
  if M.alive() then
    local win = vim.fn.win_findbuf(buf)[1]
    if win then return vim.api.nvim_set_current_win(win) end
    vim.cmd("rightbelow vsplit")
    vim.api.nvim_win_set_buf(0, buf)
    fit()
    return
  end
  vim.notify("corkboard: starting Pepper (waiting for pepper-vm)")
  if starting then return end
  starting = true
  hand_token(function(cleanup)
    starting = false
    -- Focus may have moved while it waited; the split goes beside the plan.
    local plan_win = vim.fn.win_findbuf(require("corkboard.plan").buffer())[1]
    if plan_win then vim.api.nvim_set_current_win(plan_win) end
    buf = require("corkboard.claude").start({
      split = true,
      via = VIA,
      kind = "pepper",
      prompt = PROMPT,
      args = { "--name", "Pepper" },
      on_exit = cleanup,
    })
    if not buf and cleanup then cleanup() end
    if not buf then return end
    vim.b[buf].corkboard_plan_claude = true
    fit()
  end)
end

return M
