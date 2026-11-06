-- :AgentPair lets a new device (a phone, another machine) into this
-- machine's encrypted account: the code it shows typed here, then its six
-- digits checked against these (bridge/e2ee.ts's pairApprove and pairConfirm).
-- With a page attached it's a dialog there (web/src/components/Pair.tsx),
-- which calls back M.code, M.answer and M.cancel; the command line otherwise.

local M = {}

local function cloud() return require("corkboard.cards.cloud") end

local function say(msg, level) vim.notify(msg, level or vim.log.levels.INFO, { title = "pair" }) end

-- The dialog's state, as every page shows it: step is "code", "waiting",
-- "sas", "done" or "error" (one that ends it); nil when it's closed.
local state, pass, pending

local function show(s)
  state = s
  require("corkboard").notify("corkboard.pair", s or vim.NIL)
end

-- A result for a pairing that's still the one on show: cancelled, and
-- started again, its answer's dropped.
local function current(step)
  local mine = state
  return function() return state == mine and state and state.step == step end
end

function M.code(typed)
  if not state then return end
  show({ step = "waiting", passphrase = state.passphrase })
  local live = current("waiting")
  cloud().call_async("pair_approve", function(err, got)
    if not live() then return end
    if err then return show({ step = "code", error = tostring(err), passphrase = state.passphrase }) end
    pending = got
    show({ step = "sas", name = got.name, sas = got.sas })
  end, vim.trim(typed or ""), pass)
end

function M.answer(ok)
  if not (state and state.step == "sas" and pending) then return end
  local got = pending
  pending = nil
  show({ step = "waiting", name = got.name, confirming = true })
  local live = current("waiting")
  cloud().call_async("pair_confirm", function(err, res)
    if not live() then return end
    if not ok then return show({ step = "done", name = got.name, refused = true }) end
    if err then return show({ step = "error", error = tostring(err) }) end
    show({ step = "done", name = res.name or got.name })
  end, got.id, ok == true)
end

function M.passphrase(p)
  if not state then return end
  pass = p ~= "" and p or nil
  show({ step = "code" })
end

function M.cancel()
  -- A pairing waiting on its digits is turned away, not left to time out.
  if pending then cloud().call_async("pair_confirm", function() end, pending.id, false) end
  pending, pass = nil, nil
  show(nil)
end

local function confirm(got)
  local sas = got.sas:sub(1, 3) .. " " .. got.sas:sub(4)
  vim.ui.select({ "they match", "they don't" }, { prompt = ("Does %s show %s?"):format(got.name, sas) }, function(choice)
    local ok = choice == "they match"
    cloud().call_async("pair_confirm", function(err, res)
      if not ok then return say(("%s was turned away."):format(got.name)) end
      if err then return say(err, vim.log.levels.ERROR) end
      say(("%s is in."):format(res.name))
    end, got.id, ok)
  end)
end

local function approve(p)
  vim.ui.input({ prompt = "Code on the new device: " }, function(code)
    if not code or vim.trim(code) == "" then return end
    say("waiting for the device…")
    cloud().call_async("pair_approve", function(err, got)
      if err then return say(err, vim.log.levels.ERROR) end
      confirm(got)
    end, vim.trim(code), p)
  end)
end

function M.start()
  cloud().call_async("pair_status", function(err, s)
    if err then return say(err, vim.log.levels.ERROR) end
    if not s.account then return say("this machine isn't in an encrypted account", vim.log.levels.WARN) end
    if require("corkboard").attached() then
      if pending then cloud().call_async("pair_confirm", function() end, pending.id, false) end
      pending, pass = nil, nil
      return show(s.passphrase and { step = "code", passphrase = true } or { step = "code" })
    end
    if not s.passphrase then return approve() end
    local p = vim.fn.inputsecret("Passphrase: ")
    if p ~= "" then approve(p) end
  end)
end

function M.setup()
  vim.api.nvim_create_user_command("AgentPair", M.start, { desc = "corkboard: pair a device" })
end

return M
