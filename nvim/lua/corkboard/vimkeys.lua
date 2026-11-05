-- Vim's keys, or an editor's (Settings > Editor, or the menu bar's switch),
-- vim.g.corkboard_vim, off unless turned on.
--
-- Off, every terminal is in terminal mode: a key typed after the wheel has
-- scrolled it back (into Neovim's normal mode), or over what a drag selected,
-- goes back to terminal mode and on to the program. A file is typed into as it opens, and stays so: Esc
-- does nothing, Shift with an arrow selects (select mode, which a key typed
-- replaces), and Ctrl or Cmd with Z, Shift+Z or Y, A, X undo, redo, select
-- all and cut (C and V are the page's, input.js). corkboard's own panels
-- aren't files, so keep their keys.
--
-- changed() puts that in force, or takes it away, and tells the page
-- (corkboard.vim).

local M = {}

function M.on() return vim.g.corkboard_vim == true end

local group = vim.api.nvim_create_augroup("corkboard.vimkeys", {})
local ns = vim.api.nvim_create_namespace("corkboard.vimkeys")

-- What's mapped while off: { modes, lhs, rhs }.
local MAPS = {
  { "i", "<Esc>", "<Nop>" },
  { "i", "<C-z>", "<Cmd>undo<CR>" },
  { "i", "<D-z>", "<Cmd>undo<CR>" },
  { "i", "<C-S-z>", "<Cmd>redo<CR>" },
  { "i", "<D-S-z>", "<Cmd>redo<CR>" },
  { "i", "<C-y>", "<Cmd>redo<CR>" },
  { "i", "<D-y>", "<Cmd>redo<CR>" },
  -- gH selects lines from the first, and <C-o>G stretches it to the last.
  { "i", "<C-a>", "<C-\\><C-n>gggH<C-o>G" },
  { "i", "<D-a>", "<C-\\><C-n>gggH<C-o>G" },
  { "i", "<D-f>", "<C-o>/" },
  { "s", "<C-x>", '<C-g>"+d' },
  { "s", "<D-x>", '<C-g>"+d' },
  { "s", "<C-z>", "<Esc><Cmd>undo<CR>" },
  { "s", "<D-z>", "<Esc><Cmd>undo<CR>" },
}

-- A file being edited, as opposed to a panel, a picker or a terminal.
local function file(buf)
  return vim.bo[buf].buftype == "" and vim.bo[buf].modifiable and vim.api.nvim_win_get_config(0).relative == ""
end

local function insert_soon()
  vim.schedule(function()
    if not M.on() and vim.api.nvim_get_mode().mode == "n" and file(0) then vim.cmd.startinsert() end
  end)
end

-- Keys that stay with Neovim in a scrolled-back terminal: the mouse's, and
-- a mapping's commands (Alt+h and the like).
local function neovims(key)
  local k = vim.fn.keytrans(key)
  return k:find("Mouse") or k:find("Scroll") or k:find("Drag") or k:find("Release") or k:find("^<Cmd>") or k:find("^<Focus")
end

-- And those that type, rather than copy (input.js) or leave.
local function typing(key)
  local k = vim.fn.keytrans(key)
  return #vim.fn.split(k, "\\zs") == 1 or k == "<Space>" or k == "<lt>" or k == "<BS>" or k == "<CR>" or k == "<Del>" or k == "<Tab>"
end

local paste = vim.paste
local held = {}

local function enable()
  vim.o.keymodel = "startsel,stopsel"
  vim.o.selectmode = "mouse,key"
  vim.o.selection = "exclusive"
  for _, m in ipairs(MAPS) do
    vim.keymap.set(m[1], m[2], m[3])
  end
  vim.api.nvim_create_autocmd({ "VimEnter", "BufEnter", "WinEnter" }, { group = group, callback = insert_soon })
  vim.api.nvim_create_autocmd("ModeChanged", { group = group, pattern = "*:n", callback = insert_soon })
  vim.on_key(function(key, typed)
    if typed == "" or vim.bo.buftype ~= "terminal" then return end
    local mode = vim.api.nvim_get_mode().mode
    if mode == "nt" then
      if neovims(key) then return end
    -- A selection made by dragging over it, which a key typed would replace.
    elseif not (mode:find("^[sS\19]") and typing(key)) then
      return
    end
    -- Held until terminal mode, with the rest of what came with it.
    table.insert(held, vim.fn.keytrans(typed))
    if #held > 1 then return "" end
    vim.schedule(function()
      if vim.api.nvim_get_mode().mode:find("^[sS\19]") then vim.api.nvim_feedkeys(vim.keycode("<C-\\><C-n>"), "nx", false) end
      vim.cmd.startinsert()
      vim.api.nvim_input(table.concat(held))
      held = {}
    end)
    return ""
  end, ns)
  -- A paste over a selection ends on the pasted text's last character, in
  -- normal mode: typing goes on after it.
  vim.paste = function(lines, phase)
    local selecting = vim.api.nvim_get_mode().mode:find("^[sS\19vV\22]")
    local ok = paste(lines, phase)
    if selecting and (phase == -1 or phase == 3) then
      vim.schedule(function()
        if vim.api.nvim_get_mode().mode ~= "n" then return end
        local row, col = unpack(vim.api.nvim_win_get_cursor(0))
        vim.cmd.startinsert()
        vim.api.nvim_win_set_cursor(0, { row, col + 1 })
      end)
    end
    return ok
  end
  insert_soon()
end

local function disable()
  vim.o.keymodel = ""
  vim.o.selectmode = ""
  vim.o.selection = "inclusive"
  for _, m in ipairs(MAPS) do
    pcall(vim.keymap.del, m[1], m[2])
  end
  vim.api.nvim_clear_autocmds({ group = group })
  vim.on_key(nil, ns)
  vim.paste = paste
end

function M.push() require("corkboard").notify("corkboard.vim", M.on()) end

-- Line numbers (Settings > Editor) in every window showing a file, relative
-- while Vim's keys are on, where counts like 5j read off them. A window
-- keeps its options from what it showed before, a terminal's or a panel's
-- none, so each file brings them as it opens. The setting is its own,
-- g:corkboard_number, not 'number''s global value: a panel's
-- vim.wo.number = false sets that too, as :set does.
local function numbered(win)
  local buf = vim.api.nvim_win_get_buf(win)
  return vim.bo[buf].buftype == "" and not vim.b[buf].corkboard_view and vim.api.nvim_win_get_config(win).relative == ""
end

local function shown() return vim.g.corkboard_number ~= false end

function M.number(win)
  if not numbered(win) then return end
  vim.wo[win].number = shown()
  vim.wo[win].relativenumber = shown() and M.on()
end

function M.numbers()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    M.number(win)
  end
end

vim.api.nvim_create_autocmd("BufWinEnter", {
  group = vim.api.nvim_create_augroup("corkboard.numbers", {}),
  callback = function() M.number(vim.api.nvim_get_current_win()) end,
})

local enabled = false -- whether what's above is in force

-- After the setting changed, or at setup.
function M.changed()
  if enabled == M.on() then
    if enabled then disable() else enable() end
    enabled = not enabled
  end
  require("corkboard.settings").push_keys()
  M.numbers()
  M.push()
end

return M
