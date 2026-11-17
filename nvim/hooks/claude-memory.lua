-- Claude Code's hook for a brain's memory, set by corkboard.claude: as
-- fleet/memory-hooks.nix is for a fleet slot, to the node the bridge runs
-- (bridge/node/server.ts, /memory/...).
--
--   SessionStart   GET  /memory/context, printed, which Claude Code adds to the session's context
--   PreCompact     POST /memory/episodes, the transcript so far
--   SessionEnd     POST /memory/episodes, the whole transcript
--
-- $CORKBOARD_MEMORY_URL is the node, $CORKBOARD_MEMORY_TOKEN_FILE a file
-- with its token, and $CORKBOARD_MEMORY_BRAIN the brain if not the
-- default. Without them it does nothing, and with CORKBOARD_NO_MEMORY set
-- (the consolidator's own sessions, which are no episodes). Never fails a
-- session: curl's errors go nowhere.
--
-- Both carry the project: the repo the session runs in, named for its main
-- worktree (a corkboard worktree of ~/corkboard is corkboard); not in a
-- repo, none.

local ok, input = pcall(vim.json.decode, io.read("a"))
if not ok or type(input) ~= "table" then return end

local url = os.getenv("CORKBOARD_MEMORY_URL")
if not url or url == "" or (os.getenv("CORKBOARD_NO_MEMORY") or "") ~= "" then return end
local lines = vim.F.npcall(vim.fn.readfile, os.getenv("CORKBOARD_MEMORY_TOKEN_FILE") or "")
local token = lines and lines[1] and vim.trim(lines[1])
if not token or token == "" then return end
local brain = os.getenv("CORKBOARD_MEMORY_BRAIN")
local query = brain and brain ~= "" and ("?brain=" .. vim.uri_encode(brain)) or ""

local function project()
  local cwd = type(input.cwd) == "string" and input.cwd or vim.uv.cwd()
  local run = vim.F.npcall(vim.system, { "git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir" }, { text = true })
  local r = run and run:wait(5000)
  if not r or r.code ~= 0 or not r.stdout then return end
  local name = vim.fs.basename(vim.fs.dirname(vim.trim(r.stdout)))
  if name:match("^[%w._-]+$") and #name <= 80 then return name end
end

-- The token as curl's config on its stdin, so it's not in the process list.
local function curl(args, seconds)
  local cmd = vim.list_extend({ "curl", "-fsS", "--max-time", tostring(seconds), "-K", "-" }, args)
  local run = vim.F.npcall(vim.system, cmd, { stdin = ('header = "Authorization: Bearer %s"\n'):format(token), text = true })
  return run and run:wait(seconds * 1000 + 5000)
end

local event = input.hook_event_name
if event == "SessionStart" then
  local p = project()
  local q = p and (query .. (query == "" and "?" or "&") .. "project=" .. vim.uri_encode(p)) or query
  local r = curl({ url .. "/memory/context" .. q }, 15)
  if r and r.code == 0 and r.stdout then io.write(r.stdout) end
elseif event == "PreCompact" or event == "SessionEnd" then
  local path = input.transcript_path
  local f = type(path) == "string" and io.open(path, "rb")
  if not f then return end
  local transcript = f:read("a")
  f:close()
  if transcript == "" or type(input.session_id) ~= "string" then return end
  local body = vim.fn.tempname()
  local wrote = io.open(body, "wb")
  if not wrote then return end
  wrote:write(vim.json.encode({ session = input.session_id, trigger = event == "PreCompact" and "compact" or "end", transcript = transcript, project = project() }))
  wrote:close()
  curl({ "-o", vim.fn.has("win32") == 1 and "NUL" or "/dev/null", "-H", "Content-Type: application/json", "--data-binary", "@" .. body, url .. "/memory/episodes" .. query }, 60)
  os.remove(body)
end
