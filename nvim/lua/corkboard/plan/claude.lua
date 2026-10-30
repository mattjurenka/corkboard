-- Pepper, the personal assistant (~/pepper), in the day plan's window: one
-- Claude Code session that runs all the time on the droplet
-- (fleet/pepper/pepper.nix), attached to over ssh. Closing the window leaves
-- it running; the phone's chat talks to the same session.
--
-- It plans with corkboard's MCP server (plan_read, plan_propose, notes), and
-- proposes rather than writing the calendar: the user accepts in the plan,
-- which writes it (corkboard.plan's accept).

local M = {}

-- The pepper user's key only attaches (its authorized_keys' forced command).
local ATTACH = { "ssh", "-t", "-o", "ServerAliveInterval=30", vim.env.CORKBOARD_PEPPER or "pepper@valheim.jurenka.software" }

local buf

function M.alive() return require("corkboard.terminal").alive(buf) end

-- Pepper attached to in a split (opts.split), or a tab.
local function start(opts)
  return require("corkboard.claude").start(vim.tbl_extend("force", opts or {}, {
    attach = ATTACH,
    vm = "pepper",
    kind = "pepper",
    args = { "--name", "Pepper" },
  }))
end

-- Pepper from elsewhere (the fleet view's <CR> on its VM): its window, if
-- it's open in this Neovim, or a tab attached to it.
function M.focus()
  if M.alive() then return require("corkboard.terminal").focus(buf) end
  buf = start()
end

-- Its share of the window's width, kept as the window resizes; dragging the
-- separator changes it, and from then on it's kept as dragged. Until then,
-- the plan keeps the width for its three windows (plan.lua's arrange, and
-- the day's own) as long as Claude Code keeps its own.
local share, dragged = 0.4, false
local MIN, PLAN_MIN = 60, 130
local fitted, last_columns

-- Claude Code's window, when it's beside the plan's windows and nothing else.
local function beside()
  local win = buf and vim.fn.win_findbuf(buf)[1]
  if not win then return end
  local plan = require("corkboard.plan")
  local wins = vim.tbl_filter(function(w)
    return vim.api.nvim_win_get_config(w).relative == ""
  end, vim.api.nvim_tabpage_list_wins(vim.api.nvim_win_get_tabpage(win)))
  for _, w in ipairs(wins) do
    if w ~= win and not plan.owns(vim.api.nvim_win_get_buf(w)) then return end
  end
  -- Side by side with the day, not above or below it.
  local day = vim.fn.win_findbuf(plan.buffer())[1]
  if not (day and vim.tbl_contains(wins, day)) then return end
  if vim.fn.win_screenpos(win)[1] ~= vim.fn.win_screenpos(day)[1]
    or vim.api.nvim_win_get_height(win) ~= vim.api.nvim_win_get_height(day) then return end
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

-- Open it to the right of the plan, or go to it if it's open.
function M.open()
  local win = M.alive() and vim.fn.win_findbuf(buf)[1]
  if win then return vim.api.nvim_set_current_win(win) end
  -- From the rightmost window, past the plan's priority.
  vim.cmd("999wincmd l")
  if M.alive() then
    vim.cmd("rightbelow vsplit")
    vim.api.nvim_win_set_buf(0, buf)
    fit()
    return
  end
  buf = start({ split = true })
  if not buf then return end
  vim.b[buf].corkboard_plan_claude = true
  fit()
end

return M
