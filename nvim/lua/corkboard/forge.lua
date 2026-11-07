-- Git through the forge gate (.agent/plans/forge-keys.md): Give git access
-- signs a grant from this device to another key (a VM's, an agent's), and
-- copies the chain that key shows the gate (bridge/e2ee.ts's forge*). The
-- account's devices are the account there, with nothing to do.

local M = {}

local function cloud() return require("corkboard.cards.cloud") end

local function say(msg, level) vim.notify(msg, level or vim.log.levels.INFO, { title = "git" }) end

-- The account's state, then on with it.
local function ready(then_)
  cloud().call_async("forge_status", function(err, s)
    if err then return say(err, vim.log.levels.ERROR) end
    if not s.account then return say("this machine isn't in an encrypted account", vim.log.levels.WARN) end
    then_(s)
  end)
end

local function ask(prompt, default, secret, on)
  vim.ui.input({ prompt = prompt, default = default, secret = secret }, function(v)
    if v ~= nil then on(vim.trim(v)) end
  end)
end

local DAYS = { 1, 7, 30, 90 }

function M.grant()
  ready(function(s)
    local a = {}
    ask("Holder key: ", "", false, function(holder)
      if holder == "" then return end
      a.holder = holder
      ask("Name: ", "git", false, function(name)
        a.name = name
        ask("Repos: ", s.user ~= vim.NIL and s.user .. "/" or "", false, function(repos)
          if repos == "" then return end
          a.repos = repos
          ask("Permissions: ", "contents:write pull_requests:write issues:write", false, function(perms)
            a.perms = perms
            ask("Branches: ", "agent/*", false, function(refs)
              a.refs = refs
              vim.ui.select(DAYS, {
                prompt = "Expires in",
                format_item = function(d) return d == 1 and "1 day" or (d .. " days") end,
              }, function(days)
                if not days then return end
                a.days = days
                cloud().call_async("forge_grant", function(err, got)
                  if err then return say(err, vim.log.levels.ERROR) end
                  vim.fn.setreg("+", vim.json.encode({ gate = s.gate, account = got.account, chain = got.chain }))
                  say(("git access %s copied, until %s"):format(got.name, os.date("%Y-%m-%d %H:%M", math.floor(got.expires / 1000))))
                end, a)
              end)
            end)
          end)
        end)
      end)
    end)
  end)
end

function M.revoke()
  cloud().call_async("forge_grants", function(err, grants)
    if err then return say(err, vim.log.levels.ERROR) end
    if #grants == 0 then return say("no git access given from this machine") end
    vim.ui.select(grants, {
      prompt = "Take back git access",
      format_item = function(g)
        return ("%s  %s…  until %s"):format(g.name, g.holder:sub(1, 8), os.date("%Y-%m-%d", math.floor(g.expires / 1000)))
      end,
    }, function(g)
      if not g then return end
      cloud().call_async("forge_revoke", function(e, got)
        if e then return say(e, vim.log.levels.ERROR) end
        say(("git access %s taken back"):format(got.name))
      end, g.hash)
    end)
  end)
end

return M
