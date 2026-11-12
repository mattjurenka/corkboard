-- A Claude Code session's conversation, from the fleet view, wherever the
-- session runs: another machine's page, or a VM fleetd started for one. The
-- bridge follows it through the Worker (bridge/boards.ts's fleet_follow) and
-- passes each part on as it comes; this draws it in a buffer of its own,
-- agent://session/<bridge>/<key>, in a tab, as the phone does (corkboard-
-- cloud's android Sessions.kt): what you said on a shaded row, what Claude
-- said as markdown, each tool on a line with the start of how it went, and
-- what you say in a prompt under it. With a page attached, the page draws
-- it instead, as a chat (web/src/views/Conversation.tsx), with what you say
-- in its composer; what's drawn here is under it.
--
--   i, a, o   say something, in the prompt
--   <CR>      a tool whole, or back to its line
--   1-9       an answer, while it asks
--   <C-c>     interrupt it (esc)
--   R         follow it again
--   q         close it

local M = {}

local function cloud() return require("corkboard.cards.cloud") end

local NS = vim.api.nvim_create_namespace("corkboard.conversation")

for name, hl in pairs({
  CorkboardConvYou = { link = "CursorLine" },
  CorkboardConvPrompt = { link = "Special" },
  CorkboardConvTool = { bold = true },
  CorkboardConvRunning = { link = "Special" },
  CorkboardConvError = { link = "DiagnosticError" },
  CorkboardConvDim = { link = "Comment" },
  CorkboardConvAsk = { link = "DiagnosticWarn" },
  CorkboardConvName = { bold = true },
}) do
  hl.default = true
  vim.api.nvim_set_hl(0, name, hl)
end

-- By "bridge/key": { bridge, key, name, buf, prompt, items, results,
-- opened, rows, ask, phase, state, ended }. phase: "connecting" until the
-- bridge has it, "loading" until its first batch; state: the session's, as
-- its last batch said.
local open = {}

local function page() return require("corkboard").attached() end

-- What's drawn at its foot: while it's reached, then by its state.
local function status(c)
  if c.phase == "connecting" then return "connecting…" end
  if c.phase == "loading" then return "loading…" end
  if c.state == "starting" then return "starting…" end
  if c.state == "stopping" then return "stopping…" end
  if #c.items == 0 then return "no messages yet" end
end

local function nil_if_null(v)
  if v == vim.NIL then return nil end
  return v
end

-- text's markdown highlights, by its own rows and columns: { row, col,
-- end_row, end_col, group, opts }. Kept, since a turn's text doesn't change.
local parsed = {}
local function markdown(text)
  if parsed[text] then return parsed[text] end
  local out = {}
  -- Ended with a newline, or a closing fence on its last line isn't one.
  local ok, parser = pcall(vim.treesitter.get_string_parser, text .. "\n", "markdown")
  if ok then
    parser:parse(true)
    parser:for_each_tree(function(tree, ltree)
      local lang = ltree:lang()
      local query = vim.treesitter.query.get(lang, "highlights")
      if not query then return end
      for id, node, meta in query:iter_captures(tree:root(), text) do
        local name = query.captures[id]
        if not name:match("^_") and name ~= "spell" and name ~= "nospell" then
          local sr, sc, er, ec = node:range()
          local m = meta[id] or {}
          local conceal, lines = m.conceal or meta.conceal, m.conceal_lines or meta.conceal_lines
          -- What's injected (code, inline markup) over the block it's in.
          local opts = { priority = (tonumber(meta.priority) or 100) + (lang == "markdown" and 0 or 1) }
          if conceal then opts.conceal = conceal end
          if lines then opts.conceal_lines = lines end
          table.insert(out, { sr, sc, er, ec, "@" .. name .. "." .. lang, opts })
        end
      end
    end)
  end
  parsed[text] = out
  return out
end

-- s cut to width columns, with … where it's cut.
local function clip(s, width)
  if vim.fn.strdisplaywidth(s) <= width then return s end
  local n = math.max(width - 1, 0)
  local out = vim.fn.strcharpart(s, 0, n)
  while n > 0 and vim.fn.strdisplaywidth(out) > width - 1 do
    n = n - 1
    out = vim.fn.strcharpart(s, 0, n)
  end
  return out .. "…"
end

-- The question it waits on you for: the last AskUserQuestion with no result.
local function question(c)
  for i = #c.items, 1, -1 do
    local t = c.items[i]
    if t.kind == "tool" and t.tool == "AskUserQuestion" and not c.results[t.call] then return t end
  end
end

-- Its questions whole, while it asks; and the answers typed as numbers, as
-- a permission's or an older bridge's question's.
local function asking(c)
  local q = question(c)
  local qs = q and c.state == "asking" and nil_if_null(q.questions)
  if qs and #qs > 0 then
    if not c.ask or c.ask.call ~= q.call then c.ask = { call = q.call, step = 1, picks = {}, others = {} } end
    for i = 1, #qs do c.ask.picks[i] = c.ask.picks[i] or {} end
    return qs, {}
  end
  if c.state == "permission" then return nil, { "yes", "always", "no" } end
  local first = c.state == "asking" and q and nil_if_null(q.options)
  return nil, first and first[1] or {}
end

local function width(c)
  local win = vim.fn.win_findbuf(c.buf)[1]
  local info = win and vim.fn.getwininfo(win)[1]
  return info and (info.width - info.textoff) or 80
end

local function draw(c)
  if not vim.api.nvim_buf_is_valid(c.buf) then return end
  local cols = width(c)
  local lines, marks = {}, {}
  c.rows = {}
  local function mark(row, col, erow, ecol, hl, opts) table.insert(marks, { row, col, erow, ecol, hl, opts }) end
  -- text on rows of its own, the first after prefix and the rest under it:
  -- its first row, and the bytes before its text on that and the others.
  local function put(text, prefix)
    local first, pad = #lines, string.rep(" ", vim.fn.strdisplaywidth(prefix))
    for i, l in ipairs(vim.split(text, "\n", { plain = true })) do
      table.insert(lines, (i == 1 and prefix or pad) .. l)
    end
    return first, #prefix, #pad
  end
  local function whole(first, hl)
    for r = first, #lines - 1 do mark(r, 0, r, #lines[r + 1], hl) end
  end
  local function md(text, first, off1, off)
    for _, h in ipairs(markdown(text)) do
      -- One that ends at the start of a row ends there, not past its prefix.
      local er, ec = first + h[3], (h[4] == 0 and h[3] > h[1]) and 0 or h[4] + (h[3] == 0 and off1 or off)
      if er >= #lines then er, ec = #lines - 1, #lines[#lines] end
      mark(first + h[1], h[2] + (h[1] == 0 and off1 or off), er, ec, h[5], h[6])
    end
  end

  for _, t in ipairs(c.items) do
    if t.kind == "you" then
      local first = put(t.text or "", "› ")
      for r = first, #lines - 1 do mark(r, 0, r, 0, nil, { line_hl_group = "CorkboardConvYou" }) end
      mark(first, 0, first, #"› ", "CorkboardConvPrompt")
    elseif t.kind == "claude" then
      md(t.text or "", put(t.text or "", "● "))
    elseif t.kind == "tool" then
      local r = c.results[t.call]
      local opened = c.opened[t.id]
      local detail = nil_if_null(t.detail) or ""
      local name = t.tool or ""
      local head = "● " .. name
      local first = put(opened and detail or "", head .. " ")
      if not opened then lines[#lines] = head .. " " .. clip(detail:gsub("\n.*", ""), cols - vim.fn.strdisplaywidth(head) - 1) end
      mark(first, 0, first, #"●", r and (r.error and "CorkboardConvError" or "CorkboardConvDim") or "CorkboardConvRunning")
      mark(first, #"● ", first, #head, "CorkboardConvTool")
      if #lines - 1 > first or #lines[first + 1] > #head then
        mark(first, #head, #lines - 1, #lines[#lines], "CorkboardConvDim")
      end
      local text = r and nil_if_null(r.text)
      if text and text ~= "" then
        local hl = r.error and "CorkboardConvError" or "CorkboardConvDim"
        if opened and not r.error and (name == "Agent" or name == "Task") then
          local at = put(text, "  └ ")
          mark(at, 0, at, #"  └ ", "CorkboardConvDim")
          md(text, at, #"  └ ", #"    ")
        elseif opened then
          whole(put(text, "  └ "), hl)
        else
          local shown = vim.list_slice(vim.split(text, "\n", { plain = true }), 1, 2)
          local at = put(table.concat(vim.tbl_map(function(l) return clip(l, cols - 4) end, shown), "\n"), "  └ ")
          whole(at, hl)
        end
      end
      for row = first, #lines - 1 do c.rows[row + 1] = t.id end
    end
    table.insert(lines, "")
  end

  local qs, answers = asking(c)
  if c.state == "working" then
    mark(put("✻ working…", ""), 0, #lines - 1, #lines[#lines], "CorkboardConvRunning")
    table.insert(lines, "")
  end
  if qs then
    local a = c.ask
    local q = qs[math.min(a.step, #qs)]
    local first = put((q.header or "") .. (#qs > 1 and string.format("  %d/%d", a.step, #qs) or ""), "")
    mark(first, 0, first, #lines[#lines], "CorkboardConvAsk")
    mark(first, 0, first, #(q.header or ""), "CorkboardConvTool")
    put(q.question or "", "")
    for i, o in ipairs(nil_if_null(q.options) or {}) do
      local lead = q.multiSelect and (a.picks[a.step][i - 1] and "[x] " or "[ ] ") or (i .. " ")
      local at = put(o.label or "", lead)
      mark(at, 0, at, #lead, "CorkboardConvAsk")
      local d = nil_if_null(o.description)
      if d and d ~= "" and d ~= o.label then whole(put(d, string.rep(" ", #lead)), "CorkboardConvDim") end
    end
    if a.others[a.step] then whole(put(a.others[a.step], "› "), "CorkboardConvAsk") end
    table.insert(lines, "")
  elseif #answers > 0 then
    local row = {}
    for i, s in ipairs(answers) do table.insert(row, i .. " " .. s) end
    whole(put(table.concat(row, "   "), ""), "CorkboardConvAsk")
    table.insert(lines, "")
  end
  local foot = c.ended or status(c)
  if foot then whole(put(foot, ""), "CorkboardConvDim") end
  if lines[#lines] == "" then table.remove(lines) end

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
  for _, m in ipairs(marks) do
    local opts = vim.tbl_extend("force", { end_row = m[3], end_col = m[4], hl_group = m[5] }, m[6] or {})
    pcall(vim.api.nvim_buf_set_extmark, c.buf, NS, m[1], m[2], opts)
  end
  for _, w in ipairs(wins) do
    if at_end[w] then vim.api.nvim_win_set_cursor(w, { #lines, 0 }) end
    -- Under the page's panel, whose own header says it.
    vim.wo[w].winbar = not page() and "%#CorkboardConvName# " .. (c.name or ""):gsub("%%", "%%%%") .. "  %#CorkboardConvDim#" .. (c.ended and "ended" or c.state or "") or ""
  end
  M.push(c)
end

-- What the page draws (Conversation.tsx): all of it, each time it changes,
-- once a tick. ask: the question it's on, as asking() has it, with the
-- options ticked by their numbers from 0.
function M.push(c)
  if c.pushing or not page() then return end
  c.pushing = true
  vim.schedule(function()
    c.pushing = nil
    if not vim.api.nvim_buf_is_valid(c.buf) then return end
    local qs, answers = asking(c)
    local a = qs and c.ask
    require("corkboard").notify("corkboard.view", c.buf, {
      name = c.name,
      where = c.where,
      items = c.items,
      results = c.results,
      state = c.state or vim.NIL,
      status = c.why or status(c) or vim.NIL,
      ended = c.ended ~= nil,
      questions = qs or vim.NIL,
      ask = a and { step = a.step, picks = vim.tbl_keys(a.picks[a.step] or {}), other = a.others[a.step] or vim.NIL } or vim.NIL,
      answers = answers,
      focus = c.focus or 0,
    })
  end)
end

function M.push_all()
  for _, c in pairs(open) do M.push(c) end
end

local function say(c, text, keys, answers)
  local ok, err = pcall(cloud().call, "fleet_say", c.bridge, c.key, text, keys, answers)
  if not ok then vim.notify("corkboard: " .. tostring(err), vim.log.levels.WARN) end
end

-- The question it asks: on to the next, or, after the last, its answers
-- sent, the options picked by their numbers from 0.
local function next_question(c)
  local qs = asking(c)
  if not qs then return end
  local a = c.ask
  if a.step < #qs then
    a.step = a.step + 1
    return draw(c)
  end
  local answers = {}
  for i = 1, #qs do
    local picks = vim.tbl_keys(a.picks[i])
    table.sort(picks)
    table.insert(answers, { picks = picks, other = a.others[i] })
  end
  say(c, "", {}, answers)
end

-- n (from 1): while it asks, that option, which answers a question of one
-- choice and is ticked in one of several; or that answer, typed.
local function pick(c, n)
  local qs, answers = asking(c)
  if qs then
    local a = c.ask
    local q = qs[a.step]
    if n > #(nil_if_null(q.options) or {}) then return end
    if q.multiSelect then
      a.picks[a.step][n - 1] = not a.picks[a.step][n - 1] or nil
      return draw(c)
    end
    a.picks[a.step], a.others[a.step] = { [n - 1] = true }, nil
    return next_question(c)
  end
  if answers[n] then say(c, tostring(n), {}) end
end

-- What's typed in the prompt: while it asks, the question's answer, in your
-- words (or, empty, the ticks of one of several); else said, with enter.
local function submit(c, text)
  text = vim.trim(text)
  if asking(c) then
    local a = c.ask
    if text ~= "" then
      a.others[a.step] = text
      a.picks[a.step] = {}
    end
    return next_question(c)
  end
  if text ~= "" then say(c, text, { "enter" }) end
end

-- Its prompt, under it in the tab, made again when it was closed.
local function prompt(c)
  if c.prompt and vim.api.nvim_buf_is_valid(c.prompt) then
    local win = vim.fn.win_findbuf(c.prompt)[1]
    if win then return win end
  end
  local conv = vim.fn.win_findbuf(c.buf)[1]
  if not conv then return end
  local buf = vim.api.nvim_create_buf(false, true)
  c.prompt = buf
  vim.bo[buf].buftype = "prompt"
  vim.bo[buf].bufhidden = "wipe"
  vim.fn.prompt_setprompt(buf, "› ")
  vim.fn.prompt_setcallback(buf, function(text)
    submit(c, text)
    -- Only the prompt again, rather than all that was said.
    vim.schedule(function()
      if not vim.api.nvim_buf_is_valid(buf) then return end
      vim.api.nvim_buf_set_lines(buf, 0, -2, false, {})
      vim.bo[buf].modified = false
    end)
  end)
  vim.fn.prompt_setinterrupt(buf, function() say(c, "", { "esc" }) end)
  local win = vim.api.nvim_open_win(buf, false, { split = "below", win = conv, height = 1 })
  local wo = vim.wo[win][0]
  wo.winfixheight = true
  wo.number = false
  wo.relativenumber = false
  wo.signcolumn = "yes:1"
  wo.winhighlight = "SignColumn:Normal"
  vim.keymap.set("n", "q", function() M.close(c) end, { buffer = buf, desc = "corkboard: close the conversation" })
  vim.keymap.set("n", "<C-c>", function() say(c, "", { "esc" }) end, { buffer = buf, desc = "corkboard: interrupt the session" })
  return win
end

local function ask(c)
  -- The page's composer, which takes the keys.
  if page() then
    c.focus = (c.focus or 0) + 1
    return M.push(c)
  end
  local win = prompt(c)
  if not win then return end
  vim.api.nvim_set_current_win(win)
  vim.cmd.startinsert({ bang = true })
end

function M.close(c)
  local p = c.prompt and vim.api.nvim_buf_is_valid(c.prompt) and vim.fn.win_findbuf(c.prompt)[1]
  if p then pcall(vim.api.nvim_win_close, p, true) end
  for _, w in ipairs(vim.fn.win_findbuf(c.buf)) do pcall(vim.api.nvim_win_close, w, false) end
end

local function follow(c)
  c.ended, c.why, c.phase, c.state = nil, nil, "connecting", nil
  if vim.api.nvim_buf_is_valid(c.buf) then draw(c) end
  cloud().call_async("fleet_follow", function(err)
    if not vim.api.nvim_buf_is_valid(c.buf) then return end
    if err then
      c.why, c.phase = tostring(err), nil
      c.ended = c.why
    elseif c.phase == "connecting" then
      c.phase = "loading"
    end
    draw(c)
  end, c.bridge, c.key)
end

-- Open a session's conversation in a tab, or go to it if it's open. where:
-- the vm it runs in, its brain and Claude account, the host that's on and its
-- dir, for its status line.
function M.open(bridge, key, name, where)
  local id = bridge .. "/" .. key
  local c = open[id]
  if c and vim.api.nvim_buf_is_valid(c.buf) then
    local win = vim.fn.win_findbuf(c.buf)[1]
    if win then
      vim.api.nvim_set_current_win(win)
    else
      vim.cmd.tabnew()
      vim.api.nvim_win_set_buf(0, c.buf)
    end
    if not page() then prompt(c) end
    return
  end
  vim.cmd.tabnew()
  -- Opened from a terminal's insert mode, keys would be typed into it.
  vim.cmd.stopinsert()
  local buf = vim.api.nvim_get_current_buf()
  c = { bridge = bridge, key = key, name = name, buf = buf, items = {}, results = {}, opened = {}, rows = {} }
  open[id] = c
  vim.api.nvim_buf_set_name(buf, "agent://session/" .. id)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  -- Wrapped under the text, past its bullet.
  vim.bo[buf].formatlistpat = [[^\s*\(●\|›\|└\|\[.\]\|\d\+\)\s]]
  vim.b[buf].corkboard_name = name
  vim.b[buf].corkboard_vm = where.vm
  vim.b[buf].corkboard_brain = where.brain
  vim.b[buf].corkboard_account = where.account
  vim.b[buf].corkboard_host = where.host
  vim.b[buf].corkboard_dir = where.dir ~= "" and where.dir ~= vim.NIL and where.dir or nil
  vim.b[buf].corkboard_view = "conversation"
  c.where = { vm = where.vm, brain = where.brain, account = where.account, host = where.host, dir = vim.b[buf].corkboard_dir }
  local wo = vim.wo[0][0]
  wo.wrap = true
  wo.linebreak = true
  wo.breakindent = true
  wo.breakindentopt = "list:-1"
  wo.number = false
  wo.relativenumber = false
  wo.conceallevel = 2
  wo.concealcursor = "nc"
  -- The terminals' inset (corkboard's TermOpen).
  wo.signcolumn = "yes:1"
  wo.winhighlight = "SignColumn:Normal,WinBar:Normal,WinBarNC:Normal"
  local map = function(lhs, fn, desc) vim.keymap.set("n", lhs, fn, { buffer = buf, desc = "corkboard: " .. desc }) end
  for _, lhs in ipairs({ "i", "a", "o" }) do map(lhs, function() ask(c) end, "say something to the session") end
  map("<CR>", function()
    local t = c.rows[vim.api.nvim_win_get_cursor(0)[1]]
    if not t then return end
    c.opened[t] = not c.opened[t] or nil
    draw(c)
  end, "a tool whole, or back to its line")
  for n = 1, 9 do map(tostring(n), function() pick(c, n) end, "answer it") end
  map("<C-c>", function() say(c, "", { "esc" }) end, "interrupt the session")
  map("q", function() M.close(c) end, "close the conversation")
  map("R", function() follow(c) end, "follow it again")
  local group = vim.api.nvim_create_augroup("corkboard.conversation." .. id, { clear = true })
  -- Its tools' lines are cut to its width.
  vim.api.nvim_create_autocmd("WinResized", {
    group = group,
    callback = function()
      for _, w in ipairs(vim.v.event.windows or {}) do
        if vim.api.nvim_win_is_valid(w) and vim.api.nvim_win_get_buf(w) == buf then return draw(c) end
      end
    end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = buf,
    once = true,
    callback = function()
      open[id] = nil
      pcall(vim.api.nvim_del_augroup_by_id, group)
      if c.prompt and vim.api.nvim_buf_is_valid(c.prompt) then
        vim.schedule(function() pcall(vim.api.nvim_buf_delete, c.prompt, { force = true }) end)
      end
      cloud().send("fleet_unfollow", bridge, key)
    end,
  })
  if not page() then prompt(c) end
  follow(c)
end

-- From the page, for the conversation in buf.
local function by_buf(buf)
  for _, c in pairs(open) do
    if c.buf == buf then return c end
  end
end

-- What's typed in its composer, as in the prompt.
function M.submit(buf, text)
  local c = by_buf(buf)
  if c then submit(c, text) end
end

-- An option clicked, as its number typed (from 1).
function M.pick(buf, n)
  local c = by_buf(buf)
  if c then pick(c, n) end
end

function M.interrupt(buf)
  local c = by_buf(buf)
  if c then say(c, "", { "esc" }) end
end

function M.refollow(buf)
  local c = by_buf(buf)
  if c then follow(c) end
end

-- From the bridge: a part of one, or its end.
function M.event(event)
  local c = open[tostring(event.bridge) .. "/" .. tostring(event.key)]
  if not c then return end
  c.phase = nil
  if event.type == "conversation_end" then
    c.why = tostring(nil_if_null(event.why) or "ended")
    c.ended = c.why .. " (R to follow again)"
    return draw(c)
  end
  c.state = nil_if_null(event.state) or c.state
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
