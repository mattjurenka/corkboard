-- For a Neovim compiled to wasm, running in the page (?wasm; wasm/),
-- which has the machine's files (the worker's HOSTFS) but no processes.
-- Its processes run on the bridge's machine (bridge/wasm.ts) instead, and
-- this puts them back where corkboard looks for them: vim.system, jobstart
-- (terminals included, as nvim_open_term buffers), chansend, jobwait,
-- jobstop, executable, and vim.uv.new_fs_event.
--
-- A call goes to the bridge by way of /dev/corkboard-host, which the worker
-- answers synchronously; what comes later (output, an exit, a change to a
-- watched file) comes back as event(), over the page's socket.

local M = {}

local uv = vim.uv

local function nilify(v)
  if v == vim.NIL then return nil end
  return v
end

-- One call to the bridge, and its answer.
local function call(op, ...)
  -- A process starts where Neovim is, as it would from Neovim; the bridge
  -- is somewhere else.
  if op == "spawn" or op == "run" then
    local spec = ...
    spec.cwd = spec.cwd or uv.cwd()
  end
  local fd = assert(uv.fs_open("/dev/corkboard-host", "r+", 438))
  uv.fs_write(fd, vim.mpack.encode({ op, ... }))
  local chunks = {}
  while true do
    local s = uv.fs_read(fd, 65536)
    if not s or s == "" then break end
    chunks[#chunks + 1] = s
  end
  uv.fs_close(fd)
  local answer = vim.mpack.decode(table.concat(chunks))
  if nilify(answer.error) then error("corkboard.wasm: " .. op .. ": " .. answer.error, 2) end
  return nilify(answer.result)
end
M.call = call

-- What the bridge has running for us, by its id.
local procs = {}
-- Channels made up for jobs that aren't terminals (a terminal's is its
-- nvim_open_term channel), above any Neovim hands out.
local next_chan = 100000
local by_chan = {}

local function lines(data) return vim.split(data, "\n", { plain = true }) end

-- From the bridge: a process's output or end, or a watched file's change.
function M.event(id, kind, ...)
  local p = procs[id]
  if not p then return end
  p.on_event(kind, ...)
end

local function env_of(opts)
  local env = opts.env and vim.deepcopy(opts.env) or nil
  if env then
    for k, v in pairs(env) do env[k] = tostring(v) end
  end
  return env
end

local function as_cmd(cmd)
  if type(cmd) == "string" then return { vim.o.shell, vim.o.shellcmdflag, cmd } end
  return vim.tbl_map(tostring, cmd)
end

-- vim.system ------------------------------------------------------------

local function result(r, opts)
  local out = { code = r.code, signal = r.signal }
  for _, name in ipairs({ "stdout", "stderr" }) do
    local s = nilify(r[name])
    if opts[name] ~= false and type(opts[name]) ~= "function" then
      if s and opts.text then s = s:gsub("\r\n", "\n") end
      out[name] = s or ""
    end
  end
  return out
end

function M.system(cmd, opts, on_exit)
  if type(opts) == "function" then
    on_exit, opts = opts, nil
  end
  opts = opts or {}
  local spec = { cmd = as_cmd(cmd), cwd = opts.cwd, env = env_of(opts), clear_env = opts.clear_env or nil }
  if type(opts.stdin) == "string" then
    spec.stdin = opts.stdin
  elseif type(opts.stdin) == "table" then
    spec.stdin = table.concat(opts.stdin, "\n")
  end
  local obj = { pid = 0 }
  local done, id

  -- Running it in the background, its output and end as events.
  local function start()
    if id or done then return end
    local out = { stdout = {}, stderr = {} }
    local async = vim.deepcopy(spec)
    async.stdin = nil
    async.pipe_stdin = opts.stdin ~= nil and opts.stdin ~= false or nil
    id = call("spawn", async)
    obj.pid = id
    procs[id] = {
      on_event = function(kind, a, b)
        if kind == "stdout" or kind == "stderr" then
          if type(opts[kind]) == "function" then opts[kind](nil, a) else table.insert(out[kind], a) end
        elseif kind == "exit" then
          procs[id] = nil
          if type(opts.stdout) == "function" then opts.stdout(nil, nil) end
          if type(opts.stderr) == "function" then opts.stderr(nil, nil) end
          done = result({ code = a, signal = b, stdout = table.concat(out.stdout), stderr = table.concat(out.stderr) }, opts)
          if on_exit then on_exit(done) end
        end
      end,
    }
    if spec.stdin then call("write", id, spec.stdin) end
    if async.pipe_stdin and opts.stdin ~= true then call("close_stdin", id) end
  end

  function obj:wait(timeout)
    if done then return done end
    if not id then
      -- Not started yet: run it start to end in the one call.
      local run = vim.deepcopy(spec)
      run.timeout = timeout or opts.timeout
      done = result(call("run", run), opts)
      if on_exit then on_exit(done) end
      return done
    end
    vim.wait(timeout or opts.timeout or 1e9, function() return done ~= nil end)
    if not done then
      obj:kill("sigterm")
      return { code = 124, signal = 15, stdout = "", stderr = "" }
    end
    return done
  end
  function obj:kill(signal)
    if id and not done then call("kill", id, type(signal) == "string" and signal:upper() or nil) end
  end
  function obj:write(data)
    start()
    if data == nil then return call("close_stdin", id) end
    call("write", id, type(data) == "table" and table.concat(data, "\n") .. "\n" or data)
  end
  function obj:is_closing() return done ~= nil end

  -- A callback, a stream or stdin to write means it runs in the
  -- background, as asked; otherwise whoever waits on it runs it, and
  -- if nobody has by the next turn of the loop, it runs in the background.
  if on_exit or opts.stdin == true or type(opts.stdout) == "function" or type(opts.stderr) == "function" then
    start()
  else
    vim.schedule(start)
  end
  return obj
end

-- jobstart and its company ---------------------------------------------

-- What a terminal's process should think its size is: the smallest of the
-- windows showing it, as Neovim does for its own.
local function term_size(buf)
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

local terminals = {} -- buf -> proc
M.terminals = terminals
local function resize_terminals()
  for buf, p in pairs(terminals) do
    if vim.api.nvim_buf_is_valid(buf) and #vim.fn.win_findbuf(buf) > 0 then
      local rows, cols = term_size(buf)
      if rows ~= p.rows or cols ~= p.cols then
        p.rows, p.cols = rows, cols
        pcall(call, "resize", p.id, rows, cols)
      end
    end
  end
end

function M.jobstart(cmd, opts)
  opts = opts or {}
  local argv = as_cmd(cmd)
  local spec = {
    cmd = argv,
    cwd = opts.cwd and vim.fn.fnamemodify(opts.cwd, ":p") or nil,
    env = env_of(opts),
    clear_env = opts.clear_env or nil,
    pipe_stdin = opts.stdin ~= "null" or nil,
  }
  local p = { exited = false }
  if opts.term then
    local buf = vim.api.nvim_get_current_buf()
    p.buf = buf
    p.chan = vim.api.nvim_open_term(buf, {
      on_input = function(_, _, _, data)
        if not p.exited then call("write", p.id, data) end
      end,
    })
    p.rows, p.cols = term_size(buf)
    spec.pty = { rows = p.rows, cols = p.cols }
  else
    next_chan = next_chan + 1
    p.chan = next_chan
  end
  local ok, id = pcall(call, "spawn", spec)
  if not ok then
    if opts.term then vim.api.nvim_chan_send(p.chan, id) end
    return -1
  end
  p.id = id
  by_chan[p.chan] = p
  if p.buf then
    terminals[p.buf] = p
    local cwd = spec.cwd or vim.fn.getcwd()
    pcall(vim.api.nvim_buf_set_name, p.buf, ("term://%s//%d:%s"):format(vim.fn.fnamemodify(cwd, ":~"):gsub("/$", ""), id, table.concat(argv, " ")))
    vim.b[p.buf].terminal_job_id = p.chan
    vim.b[p.buf].terminal_job_pid = id
  end
  procs[id] = {
    on_event = function(kind, a, b)
      if kind == "stdout" or kind == "stderr" then
        if p.buf then vim.api.nvim_chan_send(p.chan, a) end
        local cb = opts["on_" .. kind]
        if cb then cb(p.chan, lines(a), kind) end
      elseif kind == "exit" then
        procs[id] = nil
        p.exited, p.code = true, b ~= 0 and 128 + b or a
        for _, name in ipairs({ "stdout", "stderr" }) do
          local cb = opts["on_" .. name]
          if cb then cb(p.chan, { "" }, name) end
        end
        if opts.on_exit then opts.on_exit(p.chan, p.code, "exit") end
        if p.buf and vim.api.nvim_buf_is_valid(p.buf) then
          terminals[p.buf] = nil
          -- TermClose's v:event.status can't be set from here.
          vim.b[p.buf].corkboard_exit_status = p.code
          pcall(vim.api.nvim_chan_send, p.chan, ("\r\n[Process exited %d]"):format(p.code))
          pcall(vim.fn.chanclose, p.chan)
        end
      end
    end,
  }
  return p.chan
end

local fn = {}
for _, name in ipairs({ "jobwait", "jobstop", "jobpid", "chansend", "chanclose", "executable", "exepath", "system", "systemlist" }) do
  fn[name] = vim.fn[name]
end

function M.jobwait(chans, timeout)
  local function codes()
    return vim.tbl_map(function(c)
      local p = by_chan[c]
      if not p then return fn.jobwait({ c }, 0)[1] end
      return p.exited and p.code or -1
    end, chans)
  end
  if timeout and timeout ~= 0 then
    vim.wait(timeout < 0 and 1e9 or timeout, function() return not vim.tbl_contains(codes(), -1) end)
  end
  return codes()
end

function M.jobstop(chan)
  local p = by_chan[chan]
  if not p then return fn.jobstop(chan) end
  if p.exited then return 0 end
  call("kill", p.id, "SIGTERM")
  return 1
end

function M.jobpid(chan)
  local p = by_chan[chan]
  if not p then return fn.jobpid(chan) end
  return p.id
end

-- To a job's process, as Neovim's chansend writes to its stdin.
function M.chansend(chan, data)
  local p = by_chan[chan]
  if not p then return fn.chansend(chan, data) end
  if p.exited then return 0 end
  if type(data) == "table" then data = table.concat(data, "\n") end
  call("write", p.id, data)
  return #data
end

function M.chanclose(chan, stream)
  local p = by_chan[chan]
  if not p then return fn.chanclose(chan, stream) end
  if not p.exited then call("close_stdin", p.id) end
  return 1
end

local which = {}
function M.exepath(name)
  if name:find("/") then return uv.fs_access(name, "X") and name or "" end
  if which[name] == nil then which[name] = call("which", name) or false end
  return which[name] or ""
end
function M.executable(name) return M.exepath(name) ~= "" and 1 or 0 end

function M.system_fn(cmd, input)
  local r = M.system(cmd, { stdin = input, text = true }):wait()
  return r.stdout .. r.stderr
end
function M.systemlist(cmd, input) return vim.split(vim.trim(M.system_fn(cmd, input)), "\n") end

-- vim.uv.new_fs_event ---------------------------------------------------

local function fs_event()
  local h = { active = false }
  function h:start(path, _, cb)
    self.path = path
    self.id = call("watch", path)
    self.active = true
    procs[self.id] = {
      on_event = function(_, name, kind)
        cb(nil, nilify(name) or vim.fs.basename(path), { [kind == "rename" and "rename" or "change"] = true })
      end,
    }
    return 0
  end
  function h:stop()
    if self.id then
      procs[self.id] = nil
      pcall(call, "unwatch", self.id)
      self.id = nil
    end
    self.active = false
    return 0
  end
  h.close = h.stop
  function h:is_active() return self.active end
  function h:is_closing() return not self.active end
  function h:getpath() return self.path end
  return h
end

-- vim.uv.spawn, for what starts processes by libuv itself (snacks.picker's
-- fd and rg): pipes that are its process's stdio, and nothing else.

local function pipe()
  local p = { closed = false }
  function p:read_start(cb) self.reader = cb return 0 end
  function p:read_stop() self.reader = nil return 0 end
  function p:write(data, cb)
    if self.proc then call("write", self.proc, type(data) == "table" and table.concat(data) or data) end
    if cb then vim.schedule(cb) end
    return 0
  end
  function p:shutdown(cb)
    if self.proc then call("close_stdin", self.proc) end
    if cb then vim.schedule(cb) end
    return 0
  end
  function p:close(cb)
    self.closed = true
    if cb then vim.schedule(cb) end
  end
  function p:is_closing() return self.closed end
  function p:is_active() return not self.closed end
  return p
end

local function spawn(path, o, on_exit)
  o = o or {}
  local env
  if o.env then
    env = {}
    for _, kv in ipairs(o.env) do
      local k, v = kv:match("^([^=]+)=(.*)$")
      if k then env[k] = v end
    end
  end
  local stdio = o.stdio or {}
  local ok, id = pcall(call, "spawn", {
    cmd = { path, unpack(o.args or {}) },
    cwd = o.cwd,
    env = env,
    clear_env = env and true or nil,
    pipe_stdin = stdio[1] and true or nil,
  })
  if not ok then return nil, id, "ENOENT" end
  local handle = { pid = id, closed = false }
  function handle:kill(sig)
    pcall(call, "kill", id, type(sig) == "string" and sig:upper() or nil)
    return 0
  end
  function handle:close(cb)
    self.closed = true
    if cb then vim.schedule(cb) end
  end
  function handle:is_closing() return self.closed end
  function handle:is_active() return not self.closed end
  if stdio[1] then stdio[1].proc = id end
  procs[id] = {
    on_event = function(kind, a, b)
      local p = kind == "stdout" and stdio[2] or kind == "stderr" and stdio[3] or nil
      if p then
        if p.reader then p.reader(nil, a) end
      elseif kind == "exit" then
        procs[id] = nil
        for i = 2, 3 do
          if stdio[i] and stdio[i].reader then stdio[i].reader(nil, nil) end
        end
        if on_exit then on_exit(a, b) end
      end
    end,
  }
  return handle, id
end

-- LuaJIT's, for code that looks for it: snacks asks jit.os which system
-- it's on, and builds strings with string.buffer.
local jit_stub = {
  os = "Linux",
  arch = "wasm32",
  version = "Lua 5.1 (no JIT)",
  version_num = 0,
  status = function() return false end,
  on = function() end,
  off = function() end,
  flush = function() end,
  opt = { start = function() end },
}

local function string_buffer()
  local B = {}
  B.__index = B
  function B:put(...)
    for i = 1, select("#", ...) do
      local v = select(i, ...)
      self.parts[#self.parts + 1] = type(v) == "table" and tostring(v) or tostring(v)
    end
    return self
  end
  function B:putf(fmt, ...) return self:put(fmt:format(...)) end
  function B:tostring() return table.concat(self.parts) end
  B.__tostring = B.tostring
  function B:get() local s = self:tostring() self.parts = {} return s end
  function B:reset() self.parts = {} return self end
  B.free = B.reset
  function B:set(s) self.parts = { s } return self end
  function B:len() return #self:tostring() end
  B.__len = B.len
  return {
    new = function() return setmetatable({ parts = {} }, B) end,
    -- Not LuaJIT's format; what wrote LuaJIT's can't be read, which its
    -- readers allow for.
    encode = vim.mpack.encode,
    decode = vim.mpack.decode,
  }
end

-- LuaJIT can yield from inside pcall and xpcall; PUC Lua 5.1, which the
-- wasm build has, can't, and snacks.picker's coroutines do. Inside a
-- coroutine these run the function in a coroutine of its own and pass its
-- yields up (as coxpcall does), with coroutine.running still the outer one.
-- Outside one, they are the real ones.
local function yieldable_pcall()
  local pcall0, xpcall0, running0, create, resume, yield, status = pcall, xpcall, coroutine.running, coroutine.create, coroutine.resume, coroutine.yield, coroutine.status
  local outer = setmetatable({}, { __mode = "k" })
  local function running()
    local co = running0()
    while co and outer[co] do co = outer[co] end
    return co
  end
  local function finish(handler, co, ok, ...)
    if not ok then return false, handler((...)) end
    if status(co) == "dead" then return true, ... end
    return finish(handler, co, resume(co, yield(...)))
  end
  local function call(handler, f, ...)
    local co = create(f)
    outer[co] = running0()
    return finish(handler, co, resume(co, ...))
  end
  local id = function(e) return e end
  _G.pcall = function(f, ...)
    if not running0() or type(f) ~= "function" then return pcall0(f, ...) end
    return call(id, f, ...)
  end
  -- LuaJIT's xpcall passes on arguments, which 5.1's doesn't.
  _G.xpcall = function(f, handler, ...)
    if running0() and type(f) == "function" then return call(handler, f, ...) end
    if select("#", ...) == 0 then return xpcall0(f, handler) end
    local args = { n = select("#", ...), ... }
    return xpcall0(function() return f(unpack(args, 1, args.n)) end, handler)
  end
  coroutine.running = running
end

-- -----------------------------------------------------------------------

function M.setup()
  if rawget(_G, "jit") == nil then _G.jit = jit_stub end
  yieldable_pcall()
  package.preload["string.buffer"] = string_buffer
  uv.spawn = spawn
  uv.new_pipe = pipe
  vim.system = M.system
  vim.fn.jobstart = M.jobstart
  vim.fn.termopen = function(cmd, opts) return M.jobstart(cmd, vim.tbl_extend("force", opts or {}, { term = true })) end
  vim.fn.jobwait = M.jobwait
  vim.fn.jobstop = M.jobstop
  vim.fn.jobpid = M.jobpid
  vim.fn.chansend = M.chansend
  vim.fn.chanclose = M.chanclose
  vim.fn.executable = M.executable
  vim.fn.exepath = M.exepath
  vim.fn.system = M.system_fn
  vim.fn.systemlist = M.systemlist
  uv.new_fs_event = fs_event
  -- :terminal starts its process itself; this one starts it by jobstart, in
  -- a new buffer in the window, as :terminal does. vim.cmd keeps a function
  -- per command, so vim.cmd.terminal() finds this one; typed, :term and
  -- :terminal become :Terminal.
  local function terminal(cmd)
    vim.api.nvim_win_set_buf(0, vim.api.nvim_create_buf(true, false))
    M.jobstart(cmd and cmd ~= "" and cmd or { vim.o.shell }, { term = true })
  end
  vim.cmd.terminal = function(cmd) terminal(type(cmd) == "table" and table.concat(cmd.args or cmd, " ") or cmd) end
  vim.api.nvim_create_user_command("Terminal", function(a) terminal(a.args) end, { nargs = "*", complete = "shellcmd" })
  for _, name in ipairs({ "te", "ter", "term", "termi", "termin", "termina", "terminal" }) do
    vim.cmd(("cnoreabbrev <expr> %s getcmdtype() == ':' && getcmdline() ==# '%s' ? 'Terminal' : '%s'"):format(name, name, name))
  end
  -- The machine's shell, not the one Neovim was built thinking of.
  if vim.env.SHELL and vim.env.SHELL ~= "" then vim.o.shell = vim.env.SHELL end
  vim.api.nvim_create_autocmd({ "VimResized", "WinResized", "BufWinEnter", "WinClosed" }, {
    group = vim.api.nvim_create_augroup("corkboard.wasm", {}),
    callback = function() vim.schedule(resize_terminals) end,
  })
end

return M
