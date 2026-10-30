-- A Claude Code session's conversation, from the fleet view, wherever the
-- session runs: another machine's page, or a VM fleetd started for one. The
-- bridge follows it through the Worker (bridge/boards.ts's fleet_follow) and
-- passes each part on as it comes; this draws it in a buffer of its own,
-- agent://session/<bridge>/<key>, in a tab: what you said, what Claude said,
-- and each tool with the start of how it went.
--
--   i, a, o   say something (sent with enter)
--   <C-c>     interrupt it (esc)
--   q         close it

local M = {}

local function cloud() return require("corkboard.cards.cloud") end

local NS = vim.api.nvim_create_namespace("corkboard.conversation")

-- By "bridge/key": { bridge, key, name, buf, items, results, ended }.
local open = {}

local function nil_if_null(v)
  if v == vim.NIL then return nil end
  return v
end

local function draw(c)
  if not vim.api.nvim_buf_is_valid(c.buf) then return end
  local lines, marks = {}, {}
  local function put(text, prefix, hl)
    local pad = string.rep(" ", vim.fn.strdisplaywidth(prefix))
    for i, l in ipairs(vim.split(text, "\n", { plain = true })) do
      table.insert(lines, (i == 1 and prefix or pad) .. l)
      marks[#lines] = hl
    end
  end
  for _, t in ipairs(c.items) do
    if t.kind == "you" then
      put(t.text or "", "› ", "Function")
    elseif t.kind == "claude" then
      put(t.text or "", "● ", "Normal")
    elseif t.kind == "tool" then
      local r = c.results[t.call]
      put(t.tool .. " " .. (nil_if_null(t.detail) or ""):gsub("\n.*", "…"), "● ", r and (r.error and "DiagnosticError" or "Comment") or "Statement")
      local text = r and nil_if_null(r.text)
      if text and text ~= "" then
        local first = vim.list_slice(vim.split(text, "\n", { plain = true }), 1, 2)
        put(table.concat(first, "\n"), "  └ ", r.error and "DiagnosticError" or "Comment")
      end
    end
    table.insert(lines, "")
  end
  if c.ended then put(c.ended, "", "Comment") end
  if #lines == 0 then lines = { "…" } end

  -- Kept at the newest, unless scrolled back.
  local wins = vim.fn.win_findbuf(c.buf)
  local at_end = {}
  for _, w in ipairs(wins) do
    at_end[w] = vim.api.nvim_win_get_cursor(w)[1] >= vim.api.nvim_buf_line_count(c.buf) - 1
  end
  vim.bo[c.buf].modifiable = true
  vim.api.nvim_buf_set_lines(c.buf, 0, -1, false, lines)
  vim.bo[c.buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(c.buf, NS, 0, -1)
  for n, hl in pairs(marks) do
    vim.api.nvim_buf_set_extmark(c.buf, NS, n - 1, 0, { end_row = n, hl_group = hl, hl_eol = false })
  end
  for _, w in ipairs(wins) do
    if at_end[w] then vim.api.nvim_win_set_cursor(w, { #lines, 0 }) end
  end
end

local function say(c, text, keys)
  local ok, err = pcall(cloud().call, "fleet_say", c.bridge, c.key, text, keys)
  if not ok then vim.notify("corkboard: " .. tostring(err), vim.log.levels.WARN) end
end

local function ask(c)
  vim.ui.input({ prompt = "› " }, function(text)
    if text and text ~= "" then say(c, text, { "enter" }) end
  end)
end

local function follow(c)
  c.ended = nil
  local ok, err = pcall(cloud().call, "fleet_follow", c.bridge, c.key)
  if not ok then
    c.ended = tostring(err)
    draw(c)
  end
end

-- Open a session's conversation in a tab, or go to it if it's open.
function M.open(bridge, key, name)
  local id = bridge .. "/" .. key
  local c = open[id]
  if c and vim.api.nvim_buf_is_valid(c.buf) then
    local win = vim.fn.win_findbuf(c.buf)[1]
    if win then return vim.api.nvim_set_current_win(win) end
    vim.cmd.tabnew()
    return vim.api.nvim_win_set_buf(0, c.buf)
  end
  vim.cmd.tabnew()
  local buf = vim.api.nvim_get_current_buf()
  c = { bridge = bridge, key = key, name = name, buf = buf, items = {}, results = {} }
  open[id] = c
  vim.api.nvim_buf_set_name(buf, "agent://session/" .. id)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.b[buf].corkboard_name = name
  vim.wo.wrap = true
  vim.wo.linebreak = true
  vim.wo.number = false
  vim.wo.relativenumber = false
  local map = function(lhs, fn, desc) vim.keymap.set("n", lhs, fn, { buffer = buf, desc = "corkboard: " .. desc }) end
  for _, lhs in ipairs({ "i", "a", "o" }) do map(lhs, function() ask(c) end, "say something to the session") end
  map("<C-c>", function() say(c, "", { "esc" }) end, "interrupt the session")
  map("q", function() vim.cmd.close() end, "close the conversation")
  map("R", function() follow(c) end, "follow it again")
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = buf,
    once = true,
    callback = function()
      open[id] = nil
      pcall(cloud().call, "fleet_unfollow", bridge, key)
    end,
  })
  draw(c)
  follow(c)
end

-- From the bridge: a part of one, or its end.
function M.event(event)
  local c = open[tostring(event.bridge) .. "/" .. tostring(event.key)]
  if not c then return end
  if event.type == "conversation_end" then
    c.ended = tostring(nil_if_null(event.why) or "ended") .. " (R to follow again)"
    return draw(c)
  end
  if event.reset then
    c.items, c.results = {}, {}
  end
  local known = {}
  for _, t in ipairs(c.items) do known[t.id] = true end
  for _, t in ipairs(event.items or {}) do
    if t.kind == "result" then
      c.results[t.call] = t
    elseif not known[t.id] then
      table.insert(c.items, t)
    end
  end
  draw(c)
end

return M
