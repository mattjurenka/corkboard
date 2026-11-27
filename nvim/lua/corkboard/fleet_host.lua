-- :AgentFleetHost lets a fleet host's fleetd into this machine's encrypted
-- account as a relay-only device: what `corkboard-fleet device` printed on
-- the host pasted here, and the command that keeps its cert handed back to
-- run there (bridge/e2ee.ts's fleetCertify). With a page attached it's a
-- dialog there (web/src/components/FleetHost.tsx), which calls back M.paste,
-- M.passphrase and M.cancel; the command line otherwise.

local M = {}

local function cloud() return require("corkboard.cards.cloud") end

local function say(msg, level) vim.notify(msg, level or vim.log.levels.INFO, { title = "fleet host" }) end

-- The dialog's state, as every page shows it: step is "paste", "waiting",
-- "cert" or "error" (one that ends it); nil when it's closed.
local state, pass

local function show(s)
  state = s
  require("corkboard").notify("corkboard.fleet_host", s or vim.NIL)
end

function M.paste(text)
  if not (state and state.step == "paste") then return end
  show({ step = "waiting" })
  local mine = state
  cloud().call_async("fleet_certify", function(err, got)
    -- Cancelled, and started again, its answer's dropped.
    if state ~= mine then return end
    -- A wrong passphrase is asked for again.
    if err and pass and tostring(err):find("passphrase") then
      pass = nil
      return show({ step = "paste", passphrase = true, error = tostring(err) })
    end
    if err then return show({ step = "paste", error = tostring(err) }) end
    pass = nil
    show({ step = "cert", name = got.name, device = got.device, command = got.command })
  end, text or "", pass)
end

function M.passphrase(p)
  if not state then return end
  pass = p ~= "" and p or nil
  show({ step = "paste" })
end

function M.cancel()
  pass = nil
  show(nil)
end

-- Without a page: asked on the command line, the command left in the
-- clipboard's register.
local function certify(p)
  vim.ui.input({ prompt = "What corkboard-fleet device printed (its id and box key): " }, function(text)
    if not text or vim.trim(text) == "" then return end
    cloud().call_async("fleet_certify", function(err, got)
      if err then return say(err, vim.log.levels.ERROR) end
      vim.fn.setreg("+", got.command)
      say(("%s is certified. The command that keeps its cert is in the clipboard; run it on the host."):format(got.name))
    end, text, p)
  end)
end

function M.start()
  if not cloud().enabled() then return say("adding a fleet host needs corkboard's bridge", vim.log.levels.WARN) end
  cloud().call_async("pair_status", function(err, s)
    if err then return say(err, vim.log.levels.ERROR) end
    if not s.account then return say("this machine isn't in an encrypted account", vim.log.levels.WARN) end
    if require("corkboard").attached() then
      pass = nil
      return show(s.passphrase and { step = "paste", passphrase = true } or { step = "paste" })
    end
    if not s.passphrase then return certify() end
    local p = vim.fn.inputsecret("Passphrase: ")
    if p ~= "" then certify(p) end
  end)
end

function M.setup()
  vim.api.nvim_create_user_command("AgentFleetHost", M.start, { desc = "corkboard: add a fleet host" })
end

return M
