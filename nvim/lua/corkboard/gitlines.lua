-- Each file's changes since the last commit, in the sign column: a bar by
-- each added or modified line and a mark where lines were deleted, in the
-- files panel's colours (added as working, modified as review, deleted as
-- blocked). The buffer's text is what is compared, so an unsaved edit
-- shows too. A file new to git is all added; an ignored one has none.

local M = {}

local ns = vim.api.nvim_create_namespace("corkboard.gitlines")
local base = {} -- buf -> HEAD's text, or false when git has nothing to say
local pending = {} -- buf -> a re-diff is scheduled
local ranges = {} -- buf -> its changes as { first line, count, kind }, for the scrollbar

local function highlights()
  local theme = require("corkboard").theme()
  vim.api.nvim_set_hl(0, "CorkboardGitAdd", { fg = theme.working })
  vim.api.nvim_set_hl(0, "CorkboardGitChange", { fg = theme.review })
  vim.api.nvim_set_hl(0, "CorkboardGitDelete", { fg = theme.blocked })
end

local function wanted(buf)
  return vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].buftype == "" and not vim.b[buf].corkboard_view
    and vim.api.nvim_buf_get_name(buf) ~= ""
end

local function sign(buf, line, text, hl)
  vim.api.nvim_buf_set_extmark(buf, ns, line, 0, { sign_text = text, sign_hl_group = hl, priority = 5 })
end

local function draw(buf)
  pending[buf], ranges[buf] = nil, nil
  if not vim.api.nvim_buf_is_valid(buf) then return end
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  local old = base[buf]
  if not old then return end
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local new = table.concat(lines, "\n") .. "\n"
  if old == "" then
    if new == "\n" then return end
    for i = 0, #lines - 1 do sign(buf, i, "▎", "CorkboardGitAdd") end
    ranges[buf] = { { 1, #lines, "add" } }
    return
  end
  local found = {}
  for _, h in ipairs(vim.diff(old, new, { result_type = "indices", algorithm = "histogram" })) do
    local count_a, start_b, count_b = h[2], h[3], h[4]
    if count_b == 0 then
      -- Gone after line start_b: marked on the line below it at the top.
      if start_b == 0 then sign(buf, 0, "▔", "CorkboardGitDelete")
      else sign(buf, math.min(start_b, #lines) - 1, "▁", "CorkboardGitDelete") end
      table.insert(found, { math.max(1, math.min(start_b, #lines)), 1, "delete" })
    else
      local hl = count_a == 0 and "CorkboardGitAdd" or "CorkboardGitChange"
      for i = start_b, start_b + count_b - 1 do
        if i <= #lines then sign(buf, i - 1, "▎", hl) end
      end
      table.insert(found, { start_b, count_b, count_a == 0 and "add" or "change" })
    end
  end
  ranges[buf] = #found > 0 and found or nil
end

local function redraw(buf)
  if pending[buf] then return end
  pending[buf] = true
  vim.defer_fn(function() draw(buf) end, 100)
end

-- HEAD's copy, read again when the file may have been committed, staged or
-- written: entering the buffer, saving it, coming back to Neovim.
local function refresh(buf)
  if not wanted(buf) then return end
  local path = vim.api.nvim_buf_get_name(buf)
  local dir, name = vim.fs.dirname(path), vim.fs.basename(path)
  if not vim.uv.fs_stat(dir) then return end
  vim.system({ "git", "show", "HEAD:./" .. name }, { cwd = dir }, function(head)
    if head.code == 0 then
      base[buf] = head.stdout
      vim.schedule(function() redraw(buf) end)
      return
    end
    -- Not in HEAD: new to git (0 here is ignored, 128 not a repository).
    vim.system({ "git", "check-ignore", "-q", "--", name }, { cwd = dir }, function(ignored)
      base[buf] = ignored.code == 1 and "" or false
      vim.schedule(function() redraw(buf) end)
    end)
  end)
end

-- buf's changes for its scrollbar (corkboard.scrollbars), or nil.
function M.ranges(buf)
  return ranges[buf]
end

function M.refresh_all()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then refresh(buf) end
  end
end

function M.setup()
  highlights()
  local group = vim.api.nvim_create_augroup("corkboard.gitlines", {})
  vim.api.nvim_create_autocmd("ColorScheme", { group = group, callback = highlights })
  vim.api.nvim_create_autocmd({ "BufReadPost", "BufEnter", "BufWritePost", "FileChangedShellPost" }, {
    group = group,
    callback = function(args) refresh(args.buf) end,
  })
  vim.api.nvim_create_autocmd("FocusGained", { group = group, callback = M.refresh_all })
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = group,
    callback = function(args)
      if base[args.buf] ~= nil then redraw(args.buf) end
    end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    callback = function(args) base[args.buf], pending[args.buf], ranges[args.buf] = nil, nil, nil end,
  })
  -- A panel's window turns its sign column off for the whole window, so a
  -- file opened there (or in a tab split from it) gets it back.
  vim.api.nvim_create_autocmd("BufWinEnter", {
    group = group,
    callback = function(args)
      if wanted(args.buf) and vim.wo[0][0].signcolumn == "no" then
        vim.wo[0][0].signcolumn = vim.go.signcolumn ~= "no" and vim.go.signcolumn or "auto"
      end
    end,
  })
end

return M
