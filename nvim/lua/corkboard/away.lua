-- Away mode (<leader>a, :AgentAway): every page goes dark but for the Claude
-- Code sessions of every project, and chimes when it's time to come back.
-- The bridge keeps it across pages (bridge/away.ts); this tells it what this
-- Neovim's sessions are doing, whenever that changes, and asks it to start.

local terminal = require("corkboard.terminal")

local M = {}

-- The bridge's channel, Neovim's stdio; nil without one (a test, a script).
local function channel()
  for _, chan in ipairs(vim.api.nvim_list_chans()) do
    if chan.stream == "stdio" and chan.mode == "rpc" then return chan.id end
  end
end

-- What Claude Code puts in a terminal's title, without its spinner.
local function title(buf)
  local t = (vim.b[buf].term_title or ""):gsub("^[^%w]+", "")
  return t ~= "" and t or nil
end

local function sessions()
  local agents = require("corkboard.agents")
  local project = vim.fs.basename(vim.fn.getcwd(-1, -1))
  local list = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    local state = vim.b[buf].corkboard_claude and terminal.alive(buf) and agents.state(buf)
    if state then
      table.insert(list, {
        buf = buf,
        project = project,
        name = vim.b[buf].corkboard_name or title(buf) or "Claude Code",
        state = state,
        detail = vim.b[buf].corkboard_asking,
      })
    end
  end
  return list
end

local last

-- After a session's state changes, or it ends. Only a change is sent.
function M.report()
  local chan = channel()
  if not chan then return end
  local list = sessions()
  local encoded = vim.json.encode(list)
  if encoded == last then return end
  last = encoded
  pcall(vim.rpcnotify, chan, "corkboard.away", "report", list)
end

function M.enter()
  local chan = channel()
  if not chan then return vim.notify("corkboard: away mode needs the bridge") end
  last = nil
  M.report()
  vim.rpcnotify(chan, "corkboard.away", "enter")
end

function M.setup()
  vim.keymap.set("n", "<leader>a", M.enter, { desc = "corkboard: away mode" })
  vim.api.nvim_create_user_command("AgentAway", M.enter, { desc = "corkboard: away mode" })
end

return M
