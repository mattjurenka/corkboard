-- Pickers, from snacks.nvim, set up for corkboard: no backdrop (a full-screen
-- float would cut the panels away), and a file picked from a panel opens in a
-- split beside it rather than replacing it.

local M = {}

local function on_panel(win)
  return win and vim.api.nvim_win_is_valid(win) and require("corkboard").is_panel(vim.api.nvim_win_get_buf(win))
end

local function confirm(picker, item, action)
  local cmd = action and action.cmd
  if not on_panel(picker.main) or (cmd and cmd ~= "vsplit") then
    return Snacks.picker.actions.jump(picker, item, action)
  end
  local main, items = picker.main, picker:selected({ fallback = true })
  vim.cmd.stopinsert()
  picker:close()
  vim.schedule(function()
    vim.api.nvim_set_current_win(main)
    for _, it in ipairs(items) do
      vim.cmd("rightbelow vsplit " .. vim.fn.fnameescape(Snacks.picker.util.path(it)))
      if it.pos then pcall(vim.api.nvim_win_set_cursor, 0, it.pos) end
    end
  end)
end

-- Files open in the window the picker was opened from, except a terminal,
-- which a file would replace; from there snacks chooses.
function M.files()
  Snacks.picker.files({ main = { current = vim.bo.buftype ~= "terminal" } })
end

-- Repos sit directly under home here; g:corkboard_project_dirs says otherwise.
-- With no project open yet (the cwd is home), the chosen one becomes this
-- window's with a global :cd, so the board and every tab follow. With one
-- open, the page opens the new one in a window of its own.
local function projects()
  Snacks.picker.projects({
    dev = vim.g.corkboard_project_dirs or { "~" },
    projects = require("corkboard").recent_projects(),
    confirm = function(picker, item)
      picker:close()
      if not item then return end
      if vim.fn.getcwd() ~= vim.uv.os_homedir() then
        require("corkboard").notify("corkboard.open", { cwd = item.file })
        return
      end
      vim.cmd.cd(vim.fn.fnameescape(item.file))
      vim.notify("Project: " .. vim.fn.fnamemodify(item.file, ":~"))
    end,
  })
end

-- The tool picker (<C-Space>). Each runs in the window it was opened from.
local tools = {
  {
    text = "New buffer",
    hint = "",
    run = function(main) vim.cmd(on_panel(main) and "rightbelow vnew" or "enew") end,
  },
  { text = "Open file", hint = "<C-f>", run = M.files },
  { text = "Open project", hint = "", run = projects },
  {
    text = "Card from this line",
    hint = "<leader>c",
    run = function()
      local lnum = vim.api.nvim_win_get_cursor(0)[1]
      require("corkboard.board").card_from_code(lnum, lnum)
    end,
  },
  { text = "Token usage", hint = "<leader>u", run = function() require("corkboard.usage").show() end },
  { text = "Day plan", hint = "<leader>p", run = function() require("corkboard.plan").show() end },
  { text = "Claude Code", hint = "<C-.>", run = function() require("corkboard.claude").open() end },
  { text = "Terminal", hint = "", run = function() require("corkboard.terminal").tab() end },
  { text = "Reload window", hint = "F5", run = function() require("corkboard.restore").reload() end },
}

function M.tools()
  -- Not picker.main: snacks skips the board's scratch buffer when it picks a
  -- main window, and would choose a terminal instead.
  local main = vim.api.nvim_get_current_win()
  Snacks.picker.pick({
    source = "corkboard_tools",
    -- Copies: snacks keeps match state on the items.
    items = vim.tbl_map(vim.deepcopy, tools),
    format = function(item)
      return { { item.text }, { item.hint ~= "" and "  " .. item.hint or "", "Comment" } }
    end,
    layout = { preset = "select" },
    confirm = function(picker, item)
      picker:close()
      if not item then return end
      vim.schedule(function()
        if vim.api.nvim_win_is_valid(main) then vim.api.nvim_set_current_win(main) end
        item.run(main)
      end)
    end,
  })
end

function M.setup()
  local ok, snacks = pcall(require, "snacks")
  if not ok then return false end
  snacks.setup({
    picker = {
      enabled = true,
      layout = { layout = { backdrop = false } },
      actions = { confirm = confirm },
    },
  })
  return true
end

return M
