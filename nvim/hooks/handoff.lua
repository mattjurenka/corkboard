-- Pepper's hand_off, from the mod (claude-plugin/hooks/work.tsx). Runs as
-- `nvim -l` with the request as JSON on stdin ({ task, project, name }) and
-- asks a main corkboard window's Neovim to start Claude Code on it
-- (corkboard.claude.handoff): the one in that project first, else any with a
-- page. Each Neovim says where it is in its corkboard.live file. Prints what
-- happened; exits 1 when nothing started.

local ok, req = pcall(vim.json.decode, io.read("a"))
if not ok or type(req) ~= "table" then
  io.write("could not read the request")
  os.exit(1)
end

local dir = vim.fs.joinpath(vim.fn.stdpath("state"), "corkboard", "live")
local found = {}
for name, kind in vim.fs.dir(dir) do
  local pid = tonumber(name:match("^(%d+)%.json$"))
  -- A file whose Neovim is gone (stopped without cleaning up) is skipped.
  if kind == "file" and pid and vim.uv.kill(pid, 0) == 0 then
    local read, live = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(vim.fs.joinpath(dir, name)), "\n")) end)
    local nvim = read and type(live) == "table" and live.nvim
    if type(nvim) == "table" and nvim.window == "main" and type(nvim.server) == "string" then table.insert(found, nvim) end
  end
end

local project = type(req.project) == "string" and vim.fs.normalize(req.project) or nil
table.sort(found, function(a, b) return a.cwd == project and b.cwd ~= project end)

local why = "no corkboard window is open"
for _, nvim in ipairs(found) do
  local chan = vim.F.npcall(vim.fn.sockconnect, "pipe", nvim.server, { rpc = true })
  if chan and chan ~= 0 then
    local called, result = pcall(vim.rpcrequest, chan, "nvim_exec_lua",
      "return { require('corkboard.claude').handoff(...) }", { req })
    if called and type(result) == "table" then
      if result[1] then
        io.write(result[2])
        os.exit(0)
      end
      why = result[2]
    end
  end
end
io.write("could not hand off: " .. why)
os.exit(1)
