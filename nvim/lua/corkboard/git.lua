-- The Git tab, pinned between the board and usage: agent://git, a plain listing with the
-- browser's HTML drawn over it (b:corkboard_view "git"), in three parts.
--
-- Worktrees: every worktree of the project's repository and of each one
-- agents have worktrees of (corkboard.worktree's, under data_dir
-- "worktrees"), with what's uncommitted, how far ahead of and behind its
-- main checkout's branch it is, what no remote has, and the session or card
-- working in it.
--
-- Pull requests: the open ones on the account's forge (the bridge's
-- git_forge, bridge/node/prs.ts's overview), with their checks and the
-- newest review from another session.
--
-- The forge: its version and how long it took to answer, who it knows us
-- as, the leader it runs on and whether its pages go through the relay
-- (nodes_list, as Settings shows them), and each repository's last CI run.
--
-- <CR> lists a repository's, a PR's or a worktree's files (see Files),
-- and flips the forge's pages; s goes to a worktree's session or card (or
-- a shell there); v to a PR's review when a card has it (else its page); o
-- opens the page; m merges a PR; d removes a worktree; r reloads.

local pinned = require("corkboard.pinned")
local util = require("corkboard.util")

local M = {}

local function ui() return require("corkboard") end
local function cloud() return require("corkboard.cards.cloud") end

local buf
local line_key = {} -- line -> item key
local selected
local s = { worktrees = {}, prs = {}, forge = nil, devices = nil, loading = true }

local function say(msg, level) vim.notify("corkboard: " .. msg, level or vim.log.levels.INFO) end

-- Every item, by key, for the actions.
local function item(key)
  for _, w in ipairs(s.worktrees) do
    if w.key == key then return "worktree", w end
  end
  for _, p in ipairs(s.prs) do
    if p.key == key then return "pr", p end
  end
  for _, r in ipairs(s.forge and s.forge.repos or {}) do
    if r.key == key then return "repo", r end
  end
  if key == "forge.web" then return "web" end
end

local function rel(iso)
  local y, mo, d, h, mi, sec = (iso or ""):match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
  if not y then return "" end
  local off = (iso:match("([+-]%d%d):?%d%d$"))
  local t = os.time({ year = y, month = mo, day = d, hour = h, min = mi, sec = sec, isdst = false })
  -- os.time read it as local; put it back to UTC, then by its own offset.
  local utc = os.time(os.date("!*t", t))
  t = t + (t - utc) - (off and tonumber(off) * 3600 or 0)
  local ago = os.time() - t
  if ago < 3600 then return math.max(0, math.floor(ago / 60)) .. "m" end
  if ago < 86400 then return math.floor(ago / 3600) .. "h" end
  return math.floor(ago / 86400) .. "d"
end

local function render_browse()
  local b = s.browse
  local lines, map = { b.title .. (b.path ~= "" and ("  " .. b.path) or "") }, {}
  if b.error then table.insert(lines, "  " .. b.error) end
  for _, e in ipairs(b.entries or {}) do
    table.insert(lines, ("  %-2s %s%s"):format(e.status or "", e.name, e.dir and "/" or ""))
    map[#lines] = e.key
  end
  return lines, map
end

local function render_text()
  local lines, map
  if s.browse then
    lines, map = render_browse()
    pinned.set_lines(buf, lines)
    line_key = map
    pinned.follow(buf, line_key, selected)
    return
  end
  lines, map = {}, {}
  table.insert(lines, "Forge")
  local f = s.forge
  if f and f.error then table.insert(lines, "  " .. f.error) end
  if f and f.version then table.insert(lines, ("  Forgejo %s  %s  %dms"):format(f.version, f.user, f.ms)) end
  if s.devices then
    table.insert(lines, "  pages via relay  " .. (s.devices.forge and "on" or "off"))
    map[#lines] = "forge.web"
  end
  for _, r in ipairs(f and f.repos or {}) do
    table.insert(lines, ("  %-30s %s"):format(r.name, r.ci and (r.ci.status .. "  " .. r.ci.title) or ""))
    map[#lines] = r.key
  end
  table.insert(lines, "")
  table.insert(lines, "Pull requests")
  for _, p in ipairs(s.prs) do
    table.insert(lines, ("  %-24s #%-4d %s"):format(p.repo, p.number, p.title))
    map[#lines] = p.key
  end
  table.insert(lines, "")
  table.insert(lines, "Worktrees")
  for _, w in ipairs(s.worktrees) do
    local bits = {}
    if w.dirty > 0 then table.insert(bits, w.dirty .. " changed") end
    if w.ahead > 0 then table.insert(bits, "↑" .. w.ahead) end
    if w.behind > 0 then table.insert(bits, "↓" .. w.behind) end
    if w.unpushed > 0 then table.insert(bits, w.unpushed .. " unpushed") end
    if w.pr then table.insert(bits, "#" .. w.pr) end
    if w.owner then table.insert(bits, w.owner.label) end
    table.insert(lines, ("  %-14s %-28s %s"):format(w.project, w.branch, table.concat(bits, "  ")))
    map[#lines] = w.key
  end
  pinned.set_lines(buf, lines)
  line_key = map
  if not selected or not pinned.line_of(map, selected) then
    local first = vim.tbl_keys(map)
    table.sort(first)
    selected = map[first[1]]
  end
  pinned.follow(buf, line_key, selected)
end

local function state()
  local leader
  for _, d in ipairs(s.devices and s.devices.devices or {}) do
    if d.leader then leader = d.name end
  end
  local file
  for _, e in ipairs(s.browse and s.browse.entries or {}) do
    if e.name == s.browse.sel and not e.dir then file = e.name end
  end
  return {
    selected = selected,
    loading = s.loading,
    worktrees = s.worktrees,
    prs = s.prs,
    forge = s.forge and vim.tbl_extend("force", s.forge, { leader = leader, web = s.devices and s.devices.forge }) or nil,
    browse = s.browse and {
      title = s.browse.title,
      ref = s.browse.ref,
      path = s.browse.path,
      entries = s.browse.entries or {},
      file = file,
      loading = s.browse.loading,
      error = s.browse.error,
    } or vim.NIL, -- not left out: the page keeps a key a state leaves out
  }
end

local function push()
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  render_text()
  ui().notify("corkboard.view", buf, state())
end

-- Worktrees ---------------------------------------------------------------------

-- Run git without waiting; cb(ok, stdout) on the main loop.
local function git(args, cwd, cb)
  local ok, err = pcall(vim.system, vim.list_extend({ "git" }, args), { cwd = cwd, text = true }, function(r)
    vim.schedule(function() cb(r.code == 0, r.stdout or "") end)
  end)
  if not ok then vim.schedule(function() cb(false, tostring(err)) end) end
end

-- The main checkouts to list: the project's, and every one agents have
-- worktrees of.
local function roots()
  local seen, out = {}, {}
  local function add(root)
    if root and not seen[root] then
      seen[root] = true
      table.insert(out, root)
    end
  end
  if not util.no_project() then add(util.repo_root(util.project_root())) end
  local base = util.data_dir("worktrees")
  for project in vim.fs.dir(base) do
    for name, kind in vim.fs.dir(vim.fs.joinpath(base, project)) do
      if kind == "directory" then add(util.repo_root(vim.fs.joinpath(base, project, name))) end
    end
  end
  return out
end

-- Who's working where: a live session's branch, a card's worktree.
local function owners()
  local by_branch, by_path = {}, {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    local branch = vim.api.nvim_buf_is_valid(b) and vim.b[b].corkboard_branch
    if branch and require("corkboard.terminal").alive(b) then
      by_branch[branch] = { kind = "session", buf = b, label = require("corkboard.session").title(b) or branch }
    end
  end
  local ok, list = pcall(require("corkboard.cards").list)
  for _, c in ipairs(ok and list or {}) do
    if c.worktree and c.worktree ~= "" then by_path[c.worktree] = { kind = "card", id = c.id, label = c.id .. " " .. (c.title or ""), pr = c.pr } end
  end
  return by_branch, by_path
end

-- `git worktree list --porcelain` as entries.
local function parse_list(out)
  local list, cur = {}, nil
  for _, l in ipairs(vim.split(out, "\n", { plain = true })) do
    if l:match("^worktree ") then
      cur = { path = l:sub(10) }
      table.insert(list, cur)
    elseif cur and l:match("^branch ") then
      cur.branch = l:sub(8):gsub("^refs/heads/", "")
    elseif cur and l:match("^HEAD ") then
      cur.head = l:sub(6)
    elseif cur and l == "detached" then
      cur.branch = "(detached)"
    elseif cur and l:match("^prunable") then
      cur.gone = true
    end
  end
  return list
end

local function load_worktrees(done)
  local by_branch, by_path = owners()
  local list, pending = {}, 0
  local function finish()
    pending = pending - 1
    if pending > 0 then return end
    table.sort(list, function(a, b)
      if a.order[1] ~= b.order[1] then return a.order[1] < b.order[1] end
      return a.order[2] < b.order[2]
    end)
    s.worktrees = list
    done()
  end
  local rs = roots()
  pending = #rs + 1
  for r, root in ipairs(rs) do
    local project = vim.fs.basename(root)
    local repo = require("corkboard.worktree").forge_repo(root)
    -- What they're ahead of and behind: origin's default branch, else
    -- the main checkout's.
    git({ "symbolic-ref", "--short", "refs/remotes/origin/HEAD" }, root, function(has, base)
      if not has then _, base = util.git({ "symbolic-ref", "--short", "HEAD" }, root) end
      base = vim.trim(base)
      git({ "worktree", "list", "--porcelain" }, root, function(ok, out)
        for i, e in ipairs(ok and parse_list(out) or {}) do
          if not e.gone then
            local owner = by_path[e.path] or by_branch[e.branch or ""]
            local w = {
              key = "wt:" .. e.path,
              path = e.path,
              root = root,
              project = project,
              repo = repo,
              branch = e.branch or "",
              head = (e.head or ""):sub(1, 7),
              main = i == 1,
              order = { r, i },
              base = base,
              dirty = 0,
              ahead = 0,
              behind = 0,
              unpushed = 0,
              owner = owner and { kind = owner.kind, id = owner.id, label = owner.label } or nil,
              card_pr = owner and owner.pr,
              here = util.is_under(vim.fn.getcwd(), e.path),
            }
            table.insert(list, w)
            pending = pending + 3
            git({ "status", "--porcelain" }, e.path, function(_, st)
              w.dirty = #vim.tbl_filter(function(l) return l ~= "" end, vim.split(st, "\n", { plain = true }))
              finish()
            end)
            if base == "" or w.branch == base or "origin/" .. w.branch == base then
              pending = pending - 1
            else
              git({ "rev-list", "--left-right", "--count", base .. "...HEAD" }, e.path, function(ok2, c)
                local behind, ahead = c:match("(%d+)%s+(%d+)")
                if ok2 and behind then w.ahead, w.behind = tonumber(ahead), tonumber(behind) end
                finish()
              end)
            end
            git({ "rev-list", "--count", "HEAD", "--not", "--remotes" }, e.path, function(ok2, c)
              w.unpushed = ok2 and tonumber(vim.trim(c)) or 0
              finish()
            end)
          end
        end
        finish()
      end)
    end)
  end
  finish()
end

-- Loading ---------------------------------------------------------------------

-- A PR's worktree and card, once both are in.
local function link()
  for _, p in ipairs(s.prs) do
    p.key = "pr:" .. p.repo .. "#" .. p.number
    p.worktree, p.card = nil, nil
    for _, w in ipairs(s.worktrees) do
      if w.repo == p.repo and w.branch == p.head then
        w.pr = p.number
        p.worktree = w.path
        if w.owner then p.owner = w.owner.label end
        if w.owner and w.owner.kind == "card" then p.card = w.owner.id end
      end
    end
  end
  for _, r in ipairs(s.forge and s.forge.repos or {}) do r.key = "repo:" .. r.name end
  for _, w in ipairs(s.worktrees) do
    if not w.pr and w.card_pr and w.card_pr ~= "" then w.pr = tonumber(w.card_pr) end
  end
end

local function load_forge(done)
  cloud().call_async("git_forge", function(err, f)
    vim.schedule(function()
      if err then
        s.forge = { error = tostring(err), repos = (s.forge or {}).repos }
        s.prs = {}
      else
        s.forge = f
        s.prs = f.prs
        for _, p in ipairs(s.prs) do
          p.ago = rel(p.updated)
          if p.review == vim.NIL then p.review = nil end
          if p.checks == vim.NIL then p.checks = nil end
        end
        for _, r in ipairs(f.repos) do
          if r.ci == vim.NIL then r.ci = nil end
          if r.ci then r.ci.ago = rel(r.ci.at) end
        end
        s.forge.prs = nil
      end
      done()
    end)
  end)
end

local function load_devices(op, ...)
  cloud().call_async(op or "nodes_list", function(err, res)
    vim.schedule(function()
      if not err then s.devices = res ~= vim.NIL and res or nil end
      push()
    end)
  end, ...)
end

-- Files -------------------------------------------------------------------------
--
-- <CR> on a repository, a pull request or a worktree lists its files in
-- place of the three parts: a repository's on its default branch and a
-- PR's on its head, from the forge; a worktree's from its directory, with
-- what git status says of each. The cursor's file shows in a window beside
-- them, a buffer of its own that can't be changed, with its filetype's
-- highlighting.
--
-- What the forge said is kept until r: a directory's entries by ref and
-- path, a file as its buffer (a local one's again once its mtime moves).
-- The files around the cursor, and the directory under it, are fetched
-- before they're asked for.

-- Past this a file's preview is cut short.
local MAX_PREVIEW = 256 * 1024
-- How many entries either side of the cursor are fetched ahead.
local AHEAD = 3

local listed = {} -- "repo@ref:path" -> the forge's entries there
local waiting = {} -- the same -> callbacks waiting on its answer
local previews = {} -- "repo@ref:path" or "dir:path" -> buffer
local pwin -- the preview's window
local leave -- out of the files, back to the three parts

local function where(b) return b.dir or (b.repo .. "@" .. b.ref) end

-- The forge's git_files at path, once however many ask; cb(err, got).
local function forge_files(b, path, cb)
  local key = where(b) .. ":" .. path
  if listed[key] then return cb(nil, listed[key]) end
  if waiting[key] then return table.insert(waiting[key], cb) end
  waiting[key] = { cb }
  cloud().call_async("git_files", function(err, got)
    vim.schedule(function()
      local cbs = waiting[key] or {}
      waiting[key] = nil
      if not err and got.entries then listed[key] = got end
      for _, f in ipairs(cbs) do f(err, got) end
    end)
  end, b.repo, b.ref, path)
end

local function local_files(b)
  local _, out = util.git({ "ls-files", "--cached", "--others", "--exclude-standard", "-z" }, b.dir)
  b.all = vim.split(out, "\0", { plain = true, trimempty = true })
  b.status = {}
  local _, st = util.git({ "status", "--porcelain", "--untracked-files=all" }, b.dir)
  for _, l in ipairs(vim.split(st, "\n", { trimempty = true })) do
    local path = l:sub(4):gsub("^.* %-> ", ""):gsub('^"(.*)"$', "%1")
    b.status[path] = vim.trim(l:sub(1, 2))
  end
end

-- The entries at b.path: what's in b.all under it, a level down.
local function local_entries(b)
  local prefix = b.path == "" and "" or b.path .. "/"
  local seen, out = {}, {}
  for _, f in ipairs(b.all) do
    if f:sub(1, #prefix) == prefix then
      local rest = f:sub(#prefix + 1)
      local name, more = rest:match("^([^/]+)(/?)")
      if name and not seen[name] then
        seen[name] = { name = name, dir = more == "/" }
        table.insert(out, seen[name])
      end
      local e = name and seen[name]
      if e and b.status[f] then e.status = e.dir and "•" or b.status[f] end
    end
  end
  table.sort(out, function(a, c)
    if a.dir ~= c.dir then return a.dir end
    return a.name < c.name
  end)
  return out
end

local function path_of(b, name) return b.path == "" and name or b.path .. "/" .. name end

local function list_win() return buf and vim.fn.win_findbuf(buf)[1] end

-- The preview's window, split off the list's on its right.
local function preview_win(pbuf)
  local lwin = list_win()
  if not lwin then return end
  if pwin and vim.api.nvim_win_is_valid(pwin) and vim.api.nvim_win_get_tabpage(pwin) == vim.api.nvim_win_get_tabpage(lwin) then
    vim.api.nvim_win_set_buf(pwin, pbuf)
  else
    pwin = vim.api.nvim_open_win(pbuf, false, { split = "right", win = lwin })
    vim.api.nvim_win_set_width(lwin, 40)
  end
  vim.wo[pwin].number = true
  vim.wo[pwin].wrap = false
  return pwin
end

local function close_preview()
  if pwin and vim.api.nvim_win_is_valid(pwin) and #vim.api.nvim_tabpage_list_wins(vim.api.nvim_win_get_tabpage(pwin)) > 1 then vim.api.nvim_win_close(pwin, true) end
  pwin = nil
end

-- Keys that would change it, for a buffer that's only read.
local EDITS = { "i", "I", "a", "A", "o", "O", "s", "S", "c", "C", "R", "x", "X", "d", "D", "p", "P", "J", "u", "<C-r>", "." }

-- A buffer for a file's text (lines), or for a note in place of it.
local function preview_buf(key, path, lines, real)
  local p = previews[key]
  if not (p and vim.api.nvim_buf_is_valid(p)) then
    p = vim.api.nvim_create_buf(false, true)
    previews[key] = p
    vim.bo[p].bufhidden = "hide"
    pcall(vim.api.nvim_buf_set_name, p, "git://" .. key)
    for _, lhs in ipairs(EDITS) do vim.keymap.set("n", lhs, "<Nop>", { buffer = p, nowait = true }) end
    vim.keymap.set("n", "q", function()
      local w = list_win()
      if w then vim.api.nvim_set_current_win(w) end
    end, { buffer = p, nowait = true, desc = "git: back to the files" })
    vim.keymap.set("n", "<Esc>", function()
      local w = list_win()
      if w then vim.api.nvim_set_current_win(w) end
      leave()
    end, { buffer = p, nowait = true, desc = "git: out of the files" })
    if real then
      vim.keymap.set("n", "<CR>", function()
        local line = vim.api.nvim_win_get_cursor(0)[1]
        vim.cmd(("tabedit +%d %s"):format(line, vim.fn.fnameescape(real)))
      end, { buffer = p, nowait = true, desc = "git: edit the file here" })
    end
  end
  vim.bo[p].modifiable = true
  vim.api.nvim_buf_set_lines(p, 0, -1, false, lines)
  vim.bo[p].modifiable = false
  vim.bo[p].modified = false
  if path then
    local ft = vim.filetype.match({ buf = p, filename = path })
    if ft and vim.bo[p].filetype ~= ft then
      vim.bo[p].filetype = ft
      local lang = vim.treesitter.language.get_lang(ft)
      if lang and pcall(vim.treesitter.language.add, lang) and vim.treesitter.language.add(lang) then pcall(vim.treesitter.start, p, lang) end
    end
  end
  return p
end

-- A file's lines from its bytes, or what to say in place of them.
local function file_lines(data, size)
  if data:find("\0", 1, true) then return { ("binary, %d B"):format(size) }, false end
  local lines = vim.split(data:sub(1, MAX_PREVIEW), "\n", { plain = true })
  if lines[#lines] == "" then table.remove(lines) end
  if #data > MAX_PREVIEW then vim.list_extend(lines, { "", ("… cut at %d KB of %d"):format(MAX_PREVIEW / 1024, size) }) end
  return lines, true
end

-- A note in the preview (loading, an error, nothing).
local function note(lines)
  local w = preview_win(preview_buf("note", nil, lines))
  if w then vim.wo[w].number = false end
end

-- The buffer for a file of b's, cb(buffer) once it's there (now, for a
-- local one or one fetched before).
local function file_buf(b, path, cb)
  local key = where(b) .. ":" .. path
  if b.dir then
    local full = vim.fs.joinpath(b.dir, path)
    local st = vim.uv.fs_stat(full)
    local mtime = st and (st.mtime.sec .. "." .. st.mtime.nsec) or "missing"
    local p = previews[key]
    if p and vim.api.nvim_buf_is_valid(p) and vim.b[p].corkboard_mtime == mtime then return cb(p) end
    local fd = io.open(full, "rb")
    local data = fd and fd:read(MAX_PREVIEW + 1) or ""
    if fd then fd:close() end
    local lines, text = file_lines(data, st and st.size or 0)
    if not fd then lines, text = { "not there" }, false end
    p = preview_buf(key, text and path, lines, fd and full)
    vim.b[p].corkboard_mtime = mtime
    return cb(p)
  end
  local p = previews[key]
  if p and vim.api.nvim_buf_is_valid(p) then return cb(p) end
  if waiting["f:" .. key] then return table.insert(waiting["f:" .. key], cb) end
  waiting["f:" .. key] = { cb }
  cloud().call_async("git_files", function(err, got)
    vim.schedule(function()
      local f = not err and got.file
      local lines, text
      if not f then
        lines, text = { tostring(err or "no such file") }, false
      elseif f.binary then
        lines, text = { ("binary, %d B"):format(f.size or 0) }, false
      else
        lines, text = file_lines(f.text ~= vim.NIL and f.text or "", f.size or 0)
        if f.cut then vim.list_extend(lines, { "", ("… cut at %d KB of %d"):format(MAX_PREVIEW / 1024, f.size) }) end
      end
      local made = preview_buf(key, text and path, lines)
      -- An error isn't kept: the next look asks again.
      if not f then previews[key] = nil end
      local cbs = waiting["f:" .. key] or {}
      waiting["f:" .. key] = nil
      for _, k in ipairs(cbs) do k(made) end
    end)
  end, b.repo, b.ref, path)
end

-- What the cursor will likely go to next: the files around it, and the
-- directory under it.
local function fetch_ahead(b, at)
  if b.dir then return end
  for i = math.max(1, at - AHEAD), math.min(#b.entries, at + AHEAD) do
    local e = b.entries[i]
    if e.dir and i == at then forge_files(b, path_of(b, e.name), function() end) end
    if not e.dir then file_buf(b, path_of(b, e.name), function() end) end
  end
end

-- The cursor's file beside the list.
function M.preview()
  local b = s.browse
  if not b then return push() end
  local at, e
  for i, x in ipairs(b.entries or {}) do
    if x.name == b.sel then at, e = i, x end
  end
  push()
  if not e then return note({}) end
  fetch_ahead(b, at)
  if e.dir then return note({}) end
  local path = path_of(b, e.name)
  local shown = false
  file_buf(b, path, function(p)
    shown = true
    if s.browse == b and b.sel == e.name and p and vim.api.nvim_buf_is_valid(p) then preview_win(p) end
  end)
  if not shown then note({ "…" }) end
end

local function show_entries(entries)
  local b = s.browse
  b.entries = entries
  for _, e in ipairs(entries) do e.key = "f:" .. e.name end
  if not (b.sel and vim.iter(entries):any(function(e) return e.name == b.sel end)) then b.sel = entries[1] and entries[1].name end
  selected = b.sel and "f:" .. b.sel
  M.preview()
end

-- The entries at the browse's path, from where its files are.
local function load_entries()
  local b = s.browse
  if b.dir then return show_entries(local_entries(b)) end
  local at = b.path
  if not listed[where(b) .. ":" .. at] then
    b.loading = true
    push()
  end
  forge_files(b, at, function(err, got)
    if s.browse ~= b or b.path ~= at then return end
    b.loading = false
    b.error = err and tostring(err) or nil
    if err then return push() end
    show_entries(got.entries or {})
  end)
end

-- What's kept, gone: the buffers once they're out of their windows.
local function forget()
  listed = {}
  for _, p in pairs(previews) do
    if vim.api.nvim_buf_is_valid(p) then
      if #vim.fn.win_findbuf(p) == 0 then
        vim.api.nvim_buf_delete(p, { force = true })
      else
        vim.bo[p].bufhidden = "wipe"
      end
    end
  end
  previews = {}
end

local function browse(b)
  b.path = ""
  b.back = selected
  s.browse = b
  if b.dir then local_files(b) end
  load_entries()
end

-- Back up a directory, or out of the files at the top.
local function up()
  local b = s.browse
  if not b then return end
  if b.path == "" then
    s.browse = nil
    selected = b.back
    close_preview()
    return push()
  end
  b.sel = b.path:match("([^/]+)$")
  b.path = b.path:match("^(.*)/[^/]+$") or ""
  load_entries()
end

function leave()
  if not s.browse then return end
  s.browse.path = ""
  up()
end

-- Straight to a directory above, with the cursor on the one it's in.
local function to(path)
  local b = s.browse
  if not (b and (path == "" or b.path == path or b.path:sub(1, #path + 1) == path .. "/")) then return end
  if path == b.path then return end
  b.sel = b.path:sub(path == "" and 1 or #path + 2):match("^[^/]+")
  b.path = path
  load_entries()
end

-- Into a directory; a local file opens in a tab.
local function enter()
  local b = s.browse
  local e = b.sel and vim.iter(b.entries or {}):find(function(x) return x.name == b.sel end)
  if not e then return end
  if e.dir then
    b.path, b.sel = path_of(b, e.name), nil
    return load_entries()
  end
  if b.dir then vim.cmd("tabedit " .. vim.fn.fnameescape(vim.fs.joinpath(b.dir, path_of(b, e.name)))) end
end

function M.reload()
  if s.browse then
    forget()
    if s.browse.dir then local_files(s.browse) end
    return load_entries()
  end
  s.loading = true
  push()
  local pending = 2
  local function done()
    pending = pending - 1
    if pending > 0 then return end
    s.loading = false
    link()
    push()
  end
  load_worktrees(done)
  load_forge(done)
  load_devices()
end

-- Actions -----------------------------------------------------------------------

local function open_url(url)
  if url and url ~= "" then vim.ui.open(url) end
end

-- A worktree's session, its card, or a shell in it.
local function go_worktree(w)
  if w.owner and w.owner.kind == "session" then
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.b[b].corkboard_branch == w.branch and require("corkboard.terminal").alive(b) then return require("corkboard.terminal").focus(b) end
    end
  end
  if w.owner and w.owner.kind == "card" then return require("corkboard.agents").attend(w.owner.id) end
  vim.cmd.tabnew()
  vim.cmd.tcd(vim.fn.fnameescape(w.path))
  vim.cmd.terminal()
  vim.cmd.startinsert()
end

local function merge(p)
  if p.card then return require("corkboard.review").approve(p.card, M.reload) end
  vim.ui.select({ "Merge #" .. p.number .. " (" .. p.head .. ") into " .. p.base, "Cancel" }, { prompt = p.repo }, function(_, i)
    if i ~= 1 then return end
    cloud().call_async("pr_merge", function(err, got)
      vim.schedule(function()
        if err then return say("merging #" .. p.number .. " failed: " .. tostring(err), vim.log.levels.ERROR) end
        local left = {}
        for _, w in ipairs(s.worktrees) do
          if w.path == p.worktree then left = require("corkboard.worktree").finish(w.root, w.path, p.head, got.into) end
        end
        say("#" .. p.number .. " merged into " .. got.into .. (#left > 0 and ("; " .. table.concat(left, "; ")) or ""))
        M.reload()
      end)
    end, p.repo, p.number, true)
  end)
end

local function drop(w)
  if w.main then return say(w.path .. " is the main checkout") end
  vim.ui.select({ "Remove " .. w.path .. " and " .. w.branch, "Cancel" }, { prompt = "Worktree" }, function(_, i)
    if i ~= 1 then return end
    local why = require("corkboard.worktree").drop(w.path, w.branch)
    if why then say(why, vim.log.levels.WARN) end
    M.reload()
  end)
end

-- name: "go" (its files), "up" (a directory up, or out at the top), "leave" (out of them), "to" (the directory key, above), "session", "review",
-- "open", "merge" or "drop", on key (the selected item's if nil).
function M.action(name, key)
  if s.browse then
    if key and name ~= "to" then M.select(key) end
    if name == "go" then enter() end
    if name == "up" then up() end
    if name == "leave" then leave() end
    if name == "to" then to(key) end
    return
  end
  local kind, it = item(key or selected)
  if kind == "worktree" then
    if name == "go" then browse({ title = it.project .. "  " .. it.branch, ref = it.branch, dir = it.path }) end
    if name == "session" then go_worktree(it) end
    if name == "drop" then drop(it) end
    if name == "open" or name == "merge" then
      for _, p in ipairs(s.prs) do
        if p.worktree == it.path then return M.action(name, p.key) end
      end
    end
  elseif kind == "pr" then
    if name == "go" then browse({ title = it.repo .. "  #" .. it.number .. "  " .. it.head, repo = it.repo, ref = it.head }) end
    if name == "review" then
      if it.card then return require("corkboard.review").open(it.card) end
      open_url(it.url)
    end
    if name == "open" then open_url(it.url) end
    if name == "merge" then merge(it) end
  elseif kind == "repo" then
    if name == "go" then browse({ title = it.name .. "  " .. it.default, repo = it.name, ref = it.default }) end
    if name == "open" then open_url(it.url) end
  elseif kind == "web" and name == "go" and s.devices then
    load_devices("nodes_forge", not s.devices.forge)
  end
end

local function on_select(key)
  selected = key
  local name = s.browse and key:match("^f:(.*)$")
  if name then
    s.browse.sel = name
    return M.preview()
  end
  push()
end

-- A click on an item: the cursor to it, in the window clicked in (or the
-- tab's).
function M.select(key, win)
  win = win or (buf and vim.fn.win_findbuf(buf)[1])
  local lnum = pinned.line_of(line_key, key)
  if lnum and win and vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_set_cursor(win, { lnum, 2 }) end
  on_select(key)
end

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  local function act(name) return function() M.action(name) end end
  buf = pinned.listing("agent://git", "git", {
    j = { function() pinned.step(line_key, 1) end, "next" },
    k = { function() pinned.step(line_key, -1) end, "previous" },
    ["<CR>"] = { act("go"), "its files" },
    l = { act("go"), "its files" },
    h = { act("up"), "back" },
    ["-"] = { act("up"), "back" },
    ["<BS>"] = { act("up"), "back" },
    ["<Esc>"] = { act("leave"), "out of the files" },
    s = { act("session"), "its session" },
    v = { act("review"), "review it" },
    o = { act("open"), "open its page" },
    m = { act("merge"), "merge the pull request" },
    d = { act("drop"), "remove the worktree" },
    r = { M.reload, "reload" },
  }, function() return line_key end, function(key)
    if key ~= selected then on_select(key) end
  end)
  return buf
end

-- Keep the tab third, after the board. Leaves focus where it was.
function M.ensure()
  if pinned.ensure("corkboard_git", pinned.index("corkboard_git"), buffer()) then M.reload() end
end

function M.open()
  M.ensure()
  pinned.show("corkboard_git", pinned.index("corkboard_git"), buffer())
  M.reload()
end

return M
