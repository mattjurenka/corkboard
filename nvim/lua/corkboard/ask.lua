-- vim.ui.input and vim.ui.select as a box on the page
-- (web/src/components/Ask.tsx) while one is attached, the command line
-- otherwise. Every page shows it; the first to answer closes it on the rest.

local M = {}

local cmdline = { input = vim.ui.input, select = vim.ui.select }
local waiting, last = {}, 0

local function show(q, on_reply)
  last = last + 1
  waiting[last] = on_reply
  q.id = last
  q.prompt = vim.trim(q.prompt or ""):gsub(":$", "")
  require("corkboard").notify("corkboard.ask", q)
end

function M.input(opts, on_confirm)
  opts = opts or {}
  if not require("corkboard").attached() then
    if not opts.secret then return cmdline.input(opts, on_confirm) end
    -- What a secret is typed into isn't shown, nor kept in the history.
    local ok, v = pcall(vim.fn.inputsecret, opts.prompt or "")
    return on_confirm(ok and v or nil)
  end
  show({ prompt = opts.prompt, default = opts.default or "", secret = opts.secret or nil }, on_confirm)
end

function M.select(items, opts, on_choice)
  opts = opts or {}
  if not require("corkboard").attached() then return cmdline.select(items, opts, on_choice) end
  local label = opts.format_item or tostring
  show({ prompt = opts.prompt, default = "", choices = vim.tbl_map(label, items) }, function(i)
    i = tonumber(i)
    if i and items[i] then return on_choice(items[i], i) end
    on_choice(nil, nil)
  end)
end

-- The page's answer: the text, or the choice's number; nil for cancelled.
function M.reply(id, answer)
  local on_reply = waiting[id]
  if not on_reply then return end
  waiting[id] = nil
  require("corkboard").notify("corkboard.ask_done", id)
  if answer == vim.NIL then answer = nil end
  vim.schedule(function() on_reply(answer) end)
end

function M.setup()
  cmdline = { input = vim.ui.input, select = vim.ui.select }
  vim.ui.input = M.input
  vim.ui.select = M.select
end

return M
