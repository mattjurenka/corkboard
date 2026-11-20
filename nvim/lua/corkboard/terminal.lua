-- Shells: the toggled one along the bottom of a tab, and shells in tabs of
-- their own.

local M = {}

-- A terminal buffer's job, for jobwait and chansend: its channel, which
-- b:terminal_job_id has where 'channel' doesn't (corkboard.wasm's).
function M.job(buf) return vim.b[buf].terminal_job_id or vim.bo[buf].channel end

-- Whether a terminal buffer's job is still running.
function M.alive(buf)
  -- An ACP agent's session (corkboard.acp) has no job of its own.
  if buf ~= nil and vim.api.nvim_buf_is_valid(buf) and vim.b[buf].corkboard_acp then return vim.b[buf].corkboard_acp_alive == true end
  return buf ~= nil and vim.api.nvim_buf_is_valid(buf) and vim.fn.jobwait({ M.job(buf) }, 0)[1] == -1
end

-- What a terminal's process should think its size is: the smallest of the
-- windows showing it, as Neovim does for its own.
function M.size(buf)
  local rows, cols
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    local info = vim.fn.getwininfo(win)[1]
    local h = info.height - (info.winbar or 0)
    local w = info.width - info.textoff
    rows = math.min(rows or h, h)
    cols = math.min(cols or w, w)
  end
  return math.max(rows or vim.o.lines - 2, 1), math.max(cols or vim.o.columns, 1)
end

-- Characters a program measures as no columns (as Claude Code's
-- string-width does) and Neovim's terminal draws as six, <200b>: U+070F,
-- U+180E, U+200B, U+200E-200F, U+202A-202E, U+2060-206F and U+FEFF. Its
-- width check runs before 'setcellwidths', so they can only be taken out.
-- ZWNJ, ZWJ and U+180B-180D join the character before them, and stay.
local DROP = { "\226\128[\139\142\143\170-\174]", "\226\129[\160-\175]", "\239\187\191", "\225\160\142", "\220\143" }
-- The start of one of them, or of U+FFF9-FFFB, cut off at a chunk's end.
local HELD = { ["\226"] = true, ["\239"] = true, ["\225"] = true, ["\220"] = true,
  ["\226\128"] = true, ["\226\129"] = true, ["\239\187"] = true, ["\239\191"] = true, ["\225\160"] = true }

-- A program's output as Neovim's terminal should get it, chunk by chunk:
-- the characters above taken out, and U+FFF9-FFFB (one column to the
-- program, six to Neovim) as U+FFFD. A character split across two chunks
-- waits for the rest; eof lets it go.
function M.filter()
  local held = ""
  return function(data, eof)
    local s = held .. data
    held = ""
    if not eof then
      held = HELD[s:sub(-2)] and s:sub(-2) or HELD[s:sub(-1)] and s:sub(-1) or ""
      s = s:sub(1, #s - #held)
    end
    for _, p in ipairs(DROP) do s = s:gsub(p, "") end
    return (s:gsub("\239\191[\185-\187]", "\239\191\189"))
  end
end

-- jobstart(cmd, { term = true }) in the current buffer, with the process's
-- output through M.filter on its way to the terminal. opts are jobstart's
-- (cwd, env, on_stdout, on_exit); on_stdout gets the filtered output, split
-- as jobstart splits it. Gives the job, as jobstart does. In the page
-- (corkboard.wasm) jobstart makes the terminal and filters itself.
-- The process behind buf's nvim_open_term exited with code, before its
-- channel is closed. TermClose's v:event.status can't be set from here; and
-- Neovim's TermClose handler says "[Terminal closed]" for any
-- nvim_open_term, so say what it says for :terminal, where it said one.
function M.exited(buf, code)
  vim.b[buf].corkboard_exit_status = code
  vim.api.nvim_create_autocmd("TermClose", {
    buffer = buf,
    once = true,
    callback = function()
      local ns = vim.api.nvim_create_namespace("nvim.terminal.exitmsg")
      for _, m in ipairs(vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {})) do
        vim.api.nvim_buf_set_extmark(buf, ns, m[2], m[3], {
          id = m[1],
          virt_text = { { ("[Process exited %d]"):format(code) } },
          virt_text_pos = "overlay",
        })
      end
    end,
  })
end

function M.start(cmd, opts)
  opts = opts or {}
  if package.loaded["corkboard.wasm"] and vim.fn.jobstart == package.loaded["corkboard.wasm"].jobstart then
    return vim.fn.jobstart(cmd, vim.tbl_extend("force", opts, { term = true }))
  end
  local buf = vim.api.nvim_get_current_buf()
  local filter, job, term, group = M.filter(), nil, nil, nil
  local rows, cols = M.size(buf)
  local function out(data, eof)
    local s = filter(data, eof)
    if s ~= "" and term then vim.api.nvim_chan_send(term, s) end
    -- An empty chunk is EOF to jobstart's callers.
    if opts.on_stdout and (s ~= "" or eof) then opts.on_stdout(job, vim.split(s, "\n", { plain = true }), "stdout") end
  end
  job = vim.fn.jobstart(cmd, {
    pty = true,
    width = cols,
    height = rows,
    cwd = opts.cwd,
    env = vim.tbl_extend("force", opts.env or {}, { TERM = "xterm-256color" }),
    -- jobstart's lines, with a NUL in one as "\n", back to the bytes.
    on_stdout = function(_, data)
      local eof = #data == 1 and data[1] == ""
      out(table.concat(vim.tbl_map(function(l) return (l:gsub("\n", "\0")) end, data), "\n"), eof)
    end,
    on_exit = function(_, code)
      if opts.on_exit then opts.on_exit(job, code, "exit") end
      -- Not on TermClose: wiping the buffer fires it before BufUnload.
      if group then pcall(vim.api.nvim_del_augroup_by_id, group) end
      if not vim.api.nvim_buf_is_valid(buf) then return end
      M.exited(buf, code)
      pcall(vim.fn.chanclose, term)
    end,
  })
  if job <= 0 then return job end
  -- Before the terminal, so TermOpen's handlers find them.
  vim.b[buf].terminal_job_id = job
  vim.b[buf].terminal_job_pid = vim.fn.jobpid(job)
  term = vim.api.nvim_open_term(buf, {
    on_input = function(_, _, _, data) pcall(vim.fn.chansend, job, data) end,
  })
  local argv = type(cmd) == "table" and table.concat(cmd, " ") or cmd
  local cwd = vim.fn.fnamemodify(opts.cwd or vim.fn.getcwd(), ":~"):gsub("/$", "")
  pcall(vim.api.nvim_buf_set_name, buf, ("term://%s//%d:%s"):format(cwd, vim.b[buf].terminal_job_pid, argv))
  -- Sized as Neovim sizes its own: when a window showing it changes.
  group = vim.api.nvim_create_augroup("corkboard.terminal." .. buf, {})
  local function resize()
    if not (vim.api.nvim_buf_is_valid(buf) and vim.fn.win_findbuf(buf)[1]) then return end
    local r, c = M.size(buf)
    if r ~= rows or c ~= cols then
      rows, cols = r, c
      pcall(vim.fn.jobresize, job, c, r)
    end
  end
  vim.api.nvim_create_autocmd({ "VimResized", "WinResized", "BufWinEnter", "WinClosed" }, {
    group = group,
    callback = function() vim.schedule(resize) end,
  })
  -- Gone with its buffer, as :terminal's is.
  vim.api.nvim_create_autocmd("BufUnload", {
    group = group,
    buffer = buf,
    once = true,
    callback = function() pcall(vim.fn.jobstop, job) end,
  })
  -- TermOpen's handlers change the window (corkboard's inset).
  resize()
  return job
end

-- A new tab showing buf, with :tabnew's empty buffer cleaned up.
local function tab_with(buf)
  vim.cmd.tabnew()
  local empty = vim.api.nvim_get_current_buf()
  vim.api.nvim_win_set_buf(0, buf)
  if empty ~= buf then pcall(vim.api.nvim_buf_delete, empty, {}) end
end

-- A shell in a tab of its own.
function M.tab()
  if require("corkboard.projects").need() then return end
  vim.cmd.tabnew()
  local empty = vim.api.nvim_get_current_buf()
  vim.cmd.terminal()
  if empty ~= vim.api.nvim_get_current_buf() then pcall(vim.api.nvim_buf_delete, empty, {}) end
  vim.t.corkboard_terminal_tab = true
end

-- <C-`>: a shell along the bottom of the tab. Toggles: hidden when shown,
-- back (the same shell) when not. One per tab, made again once it exits.
-- Not in a shell's own tab. Beside a session in a VM, the shell is in its VM.
function M.toggle()
  if require("corkboard.projects").need() then return end
  if vim.t.corkboard_terminal_tab then return end
  local buf = vim.t.corkboard_terminal
  local alive = M.alive(buf)
  for _, win in ipairs(buf and vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_tabpage_list_wins(0) or {}) do
    if vim.api.nvim_win_get_buf(win) == buf then
      -- The last window of a tab can't be hidden.
      if #vim.api.nvim_tabpage_list_wins(0) == 1 then return end
      vim.api.nvim_win_hide(win)
      if not alive then pcall(vim.api.nvim_buf_delete, buf, { force = true }) end
      return
    end
  end
  if alive then
    vim.cmd("botright 15split")
    vim.api.nvim_win_set_buf(0, buf)
  else
    local shell = vim.b.corkboard_shell
    for _, win in ipairs(shell and {} or vim.api.nvim_tabpage_list_wins(0)) do
      shell = shell or vim.b[vim.api.nvim_win_get_buf(win)].corkboard_shell
    end
    vim.cmd("botright 15split")
    vim.cmd.enew()
    vim.fn.jobstart(shell or { vim.o.shell }, { term = true })
    vim.bo.bufhidden = "hide"
    vim.t.corkboard_terminal = vim.api.nvim_get_current_buf()
  end
end

-- Go to a terminal: the window showing it, or a new tab if it is hidden.
-- False when the buffer is gone.
function M.focus(buf)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return false end
  local win = vim.fn.win_findbuf(buf)[1]
  if win then
    vim.api.nvim_set_current_win(win)
  else
    tab_with(buf)
  end
  return true
end

return M
