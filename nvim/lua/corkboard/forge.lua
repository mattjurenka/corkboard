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

-- Put this project on the forge: the clone's branches and tags go to a
-- private repository of the account's there (made if there's none), and
-- that becomes origin, the one it had kept under its host's name
-- (bridge/forge-git.ts's adopt). Nothing there is overwritten. A project
-- that came from somewhere is asked which keeps its main: the forge, with
-- GitHub a mirror it pushes to; or where it came from, for one teammates
-- work on there, which the forge then follows.
function M.adopt(dir)
  local util = require("corkboard.util")
  local root = util.repo_root(dir or vim.fn.getcwd())
  if not root then return say("this project isn't a git repository", vim.log.levels.WARN) end
  local function put(name, follows)
    say(("putting %s on the forge…"):format(name))
    -- A first push of a long history takes a while.
    cloud().call_within(30 * 60 * 1000, "forge_adopt", function(err, got)
      if err then return say(err, vim.log.levels.ERROR) end
      if got.already then return say(("origin is %s on the forge already"):format(got.repo)) end
      local has = function(v) return v and v ~= vim.NIL end
      local lines = { ("%s is on the forge (%d branch%s), and origin here"):format(got.repo, got.branches, got.branches == 1 and "" or "es") }
      if has(got.follows) then
        table.insert(lines, ("%s keeps its main: the forge follows it, and a branch that's ready is pushed there"):format(got.follows))
      elseif has(got.kept) then
        table.insert(lines, ("the remote that was origin is %s"):format(got.kept))
      end
      if has(got.mirror) then table.insert(lines, ("the forge pushes every commit to github.com/%s"):format(got.mirror)) end
      vim.list_extend(lines, got.notes or {})
      say(table.concat(lines, "\n"))
    end, root, name, follows)
  end
  ask("Name on the forge: ", vim.fs.basename(root), false, function(name)
    if name == "" then return end
    local ok, origin = util.git({ "config", "--get", "remote.origin.url" }, root)
    origin = ok and vim.trim(origin) or ""
    if origin == "" or require("corkboard.worktree").forge_repo(root) then return put(name, false) end
    vim.ui.select({
      "The forge: it's mine, and where it came from becomes a mirror",
      "Where it came from: teammates work there, and the forge follows it",
    }, { prompt = "Which keeps " .. name .. "'s main (" .. origin .. ")?" }, function(_, i)
      if i then put(name, i == 2) end
    end)
  end)
end

-- A branch that's ready, in a project whose main is kept on another remote
-- (worktree.upstream): pushed there, and its pull request's page opened.
-- done(err, { remote, branch, url }).
function M.offer(root, branch, done)
  cloud().call_within(10 * 60 * 1000, "forge_offer", function(err, got)
    if not err and got.url and got.url ~= vim.NIL then vim.ui.open(got.url) end
    done(err, got)
  end, root, branch)
end

return M
