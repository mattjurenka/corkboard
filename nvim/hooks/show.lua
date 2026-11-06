-- The mod's show (claude-plugin/hooks/show.tsx). Runs as `nvim -l` with the
-- request as JSON on stdin ({ server, buf, path, title }) and asks the
-- Neovim whose terminal the session is in to put the file in its media
-- panel (corkboard.claude.cards.show_file). Prints what happened; exits 1
-- when it isn't shown.

local ok, req = pcall(vim.json.decode, io.read("a"))
if not ok or type(req) ~= "table" or type(req.server) ~= "string" or type(req.path) ~= "string" then
  io.write("could not read the request")
  os.exit(1)
end

local chan = vim.F.npcall(vim.fn.sockconnect, "pipe", req.server, { rpc = true })
if not chan or chan == 0 then
  io.write("could not reach corkboard's Neovim")
  os.exit(1)
end
local called, result = pcall(vim.rpcrequest, chan, "nvim_exec_lua",
  "return { require('corkboard.claude.cards').show_file(...) }", { tonumber(req.buf) or -1, req.path, req.title })
if called and type(result) == "table" then
  io.write(result[2] or "")
  os.exit(result[1] and 0 or 1)
end
io.write("could not show it: " .. tostring(result))
os.exit(1)
