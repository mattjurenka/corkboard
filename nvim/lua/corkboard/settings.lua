-- The Settings tab (File > Settings, Ctrl+, or :AgentSettings): every setting
-- declared once below, with its type, which the page picks a control by.
-- What's changed is kept in ~/.config/corkboard/settings.json and applied at
-- setup, over whatever init.lua set, to the vim.g variable or option the
-- setting stands for, so what reads it is unchanged.
--
-- A plain listing, agent://settings, with the browser's HTML drawn over it.
-- The cursor's line selects; <CR> changes the setting (toggles, picks or asks
-- for it) and x puts it back to its default.
--
-- Devices are the encrypted account's, as the relay knows them (the bridge's
-- node's nodes_*): <CR> on one makes it the leader, or no longer, and on the
-- address copies it.
--
-- Keybindings are corkboard's own shortcuts, every global mapping whose desc
-- starts "corkboard: ", a setting each, gathered once init.lua has made them
-- (M.keys).

local pinned = require("corkboard.pinned")

local M = {}

M.PATH = (vim.env.XDG_CONFIG_HOME or vim.fs.normalize("~/.config")) .. "/corkboard/settings.json"

local function ui() return require("corkboard") end

-- The page's colors; nil leaves each to the colorscheme (init.lua's theme).
local function color(name, label)
  return {
    key = "color." .. name,
    label = label,
    type = "color",
    get = function() return (vim.g.corkboard_colors or {})[name] end,
    set = function(v)
      local colors = vim.g.corkboard_colors or {}
      colors[name] = v
      vim.g.corkboard_colors = colors
    end,
    theme = true,
  }
end

-- vim.g.corkboard_font's fields.
local function font(field)
  return {
    get = function() return (vim.g.corkboard_font or {})[field] end,
    set = function(v)
      local f = vim.g.corkboard_font or {}
      f[field] = v
      vim.g.corkboard_font = next(f) and f or nil
    end,
    theme = true,
  }
end

-- A window option, in every window showing a file.
local function option(name)
  return {
    get = function() return vim.o[name] end,
    set = function(v)
      if v == nil then v = vim.api.nvim_get_option_info2(name, {}).default end
      vim.o[name] = v
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.bo[vim.api.nvim_win_get_buf(win)].buftype == "" then vim.wo[win][name] = v end
      end
    end,
  }
end

-- One of corkboard.features, put in force as it changes.
local function feature(name)
  return {
    get = function() return vim.g["corkboard_" .. name] == true end,
    set = function(v)
      vim.g["corkboard_" .. name] = v
      require("corkboard.features").changed()
    end,
  }
end

-- The page's zoom, in percent of its font size, stepped as a browser does.
local ZOOM = { 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300 }

-- type: text, number, bool, color, enum (options: values, or { value,
-- label }s, or a function returning them), list (of text) or keys (of
-- key sequences, in Neovim's notation). A setting
-- is read from vim.g[g] unless it has its own get and set; default is what
-- the code reading it falls back on, and placeholder stands in for one it
-- works out.
M.SCHEMA = {
  {
    section = "Appearance",
    items = {
      {
        key = "colorscheme",
        label = "Color theme",
        type = "enum",
        options = function() return vim.fn.getcompletion("", "color") end,
        get = function() return vim.g.colors_name end,
        set = function(v) if v then vim.cmd.colorscheme(v) end end,
      },
      vim.tbl_extend("error", { key = "font.family", label = "Font", type = "text", placeholder = "monospace" }, font("family")),
      vim.tbl_extend("error", { key = "font.size", label = "Font size", type = "number", min = 8, max = 32, step = 1, unit = "pt", placeholder = "13" }, font("size")),
      { key = "zoom", label = "Zoom", type = "number", min = ZOOM[1], max = ZOOM[#ZOOM], step = 10, unit = "%", placeholder = "100", g = "corkboard_zoom", theme = true },
      color("focus", "Focus color"),
      color("accent", "Accent color"),
      color("selection", "Selection color"),
      color("working", "Working color"),
      color("review", "Review color"),
      color("blocked", "Blocked color"),
      color("special", "Fourth color"),
    },
  },
  {
    section = "Editor",
    items = {
      {
        key = "number",
        label = "Line numbers",
        type = "bool",
        default = true,
        get = function() return vim.g.corkboard_number ~= false end,
        set = function(v)
          vim.g.corkboard_number = v ~= false
          require("corkboard.vimkeys").numbers()
        end,
      },
      vim.tbl_extend("error", { key = "wrap", label = "Wrap lines", type = "bool", default = true }, option("wrap")),
      {
        key = "vim",
        label = "Vim keys",
        type = "bool",
        default = false,
        get = function() return vim.g.corkboard_vim == true end,
        set = function(v)
          vim.g.corkboard_vim = v
          require("corkboard.vimkeys").changed()
        end,
      },
      { key = "markdown_preview", label = "Markdown preview", type = "bool", default = true, g = "corkboard_markdown_preview" },
      { key = "focus_width", label = "Focus mode width", type = "number", min = 40, max = 200, step = 2, unit = "columns", placeholder = "100", g = "corkboard_focus_width" },
    },
  },
  {
    section = "Agents",
    items = {
      { key = "max_agents", label = "Agents at once", type = "number", min = 1, max = 12, step = 1, default = 3, g = "corkboard_max_agents" },
      { key = "clear_when_done", label = "Clear an agent when its card is done", type = "bool", default = true, g = "corkboard_clear_when_done" },
      {
        key = "context_limit",
        label = "Context window",
        type = "enum",
        options = { { value = 200000, label = "200k" }, { value = 1000000, label = "1M" } },
        default = 200000,
        g = "corkboard_context_limit",
      },
      { key = "agent_args", label = "Agent arguments", type = "list", default = {}, g = "corkboard_agent_args" },
    },
  },
  {
    section = "Autopilot",
    items = {
      { key = "ai_intake", label = "Write up new cards", type = "bool", default = true, g = "corkboard_ai_intake" },
      { key = "autopilot", label = "Start ready cards", type = "bool", default = false, g = "corkboard_autopilot" },
      { key = "groom_minutes", label = "Groom the board every", type = "number", min = 0, step = 5, unit = "minutes", default = 30, placeholder = "never", g = "corkboard_groom_minutes" },
      { key = "archive_done_hours", label = "Archive done cards after", type = "number", min = 0, step = 1, unit = "hours", default = 24, placeholder = "never", g = "corkboard_archive_done_hours" },
      { key = "pre_review", label = "Review before me", type = "bool", default = true, g = "corkboard_pre_review" },
      { key = "review_rounds", label = "Send back at most", type = "number", min = 0, max = 10, step = 1, unit = "times", default = 2, g = "corkboard_review_rounds" },
      { key = "auto_merge", label = "Merge low-risk work", type = "bool", default = false, g = "corkboard_auto_merge" },
      {
        key = "planner_model",
        label = "Planner model",
        type = "enum",
        options = { "haiku", "sonnet", "opus" },
        default = "sonnet",
        g = "corkboard_planner_model",
      },
      {
        key = "reviewer_model",
        label = "Reviewer model",
        type = "enum",
        options = { "haiku", "sonnet", "opus" },
        default = "sonnet",
        g = "corkboard_reviewer_model",
      },
    },
  },
  {
    section = "Budget",
    items = {
      { key = "budget_card", label = "Per card", type = "number", min = 0, step = 1, unit = "$", placeholder = "no limit", g = "corkboard_budget_card" },
      { key = "budget_day", label = "Per day", type = "number", min = 0, step = 5, unit = "$", placeholder = "no limit", g = "corkboard_budget_day" },
      { key = "budget_block", label = "Hold agents over budget", type = "bool", default = false, g = "corkboard_budget_block" },
    },
  },
  {
    section = "Projects",
    items = {
      { key = "project_dirs", label = "Project folders", type = "list", default = { "~" }, g = "corkboard_project_dirs" },
    },
  },
  {
    section = "Features",
    items = {
      vim.tbl_extend("error", { key = "fleet", label = "Fleet", type = "bool", default = false }, feature("fleet")),
      vim.tbl_extend("error", { key = "assistant", label = "Day plan and meetings", type = "bool", default = false }, feature("assistant")),
    },
  },
}

local by_key = {}
for _, s in ipairs(M.SCHEMA) do
  for _, item in ipairs(s.items) do by_key[item.key] = item end
end

local function get(item)
  if item.get then return item.get() end
  return vim.g[item.g]
end

local function apply(item, v)
  if item.set then item.set(v) else vim.g[item.g] = v end
  if item.theme then ui().push_theme() end
  if item.type == "keys" then M.push_keys() end
end

local function options(item)
  local opts = type(item.options) == "function" and item.options() or item.options
  return vim.tbl_map(function(o) return type(o) == "table" and o or { value = o, label = tostring(o) } end, opts)
end

-- Saved -----------------------------------------------------------------------

local saved -- key -> value, as in the file

local function read()
  if saved then return saved end
  local f = io.open(M.PATH)
  saved = {}
  if not f then return saved end
  local ok, t = pcall(vim.json.decode, f:read("*a"))
  f:close()
  if ok and type(t) == "table" then saved = t end
  return saved
end

local function write()
  vim.fn.mkdir(vim.fs.dirname(M.PATH), "p")
  local f = assert(io.open(M.PATH, "w"))
  f:write(vim.json.encode(next(saved) and saved or vim.empty_dict()))
  f:close()
end

-- The view -------------------------------------------------------------------

local buf
local line_key = {} -- line number -> setting key
local selected
-- { url, leader, devices = { { device, name, seen, me, connected, leader } } },
-- or nil: not asked yet, or this machine isn't in a relay's account.
local devices

local function shown(v, item)
  if v == nil then return item.placeholder or "" end
  if item.type == "bool" then return v and "on" or "off" end
  if item.type == "list" then return table.concat(v, ", ") end
  if item.type == "keys" then return #v > 0 and table.concat(v, " ") or "none" end
  if item.type == "enum" then
    for _, o in ipairs(options(item)) do
      if o.value == v then return o.label end
    end
  end
  return tostring(v)
end

local function state()
  local theme = ui().theme(true)
  return {
    selected = selected,
    sections = vim.tbl_map(function(s)
      return {
        title = s.section,
        items = vim.tbl_map(function(item)
          local v = get(item)
          return {
            key = item.key,
            label = item.label,
            type = item.type,
            value = v == nil and vim.NIL or v,
            -- What a color left to the colorscheme is.
            theme = item.type == "color" and theme[item.key:sub(7)] or nil,
            default = item.default == nil and vim.NIL or item.default,
            placeholder = item.placeholder,
            min = item.min,
            max = item.max,
            step = item.step,
            unit = item.unit,
            options = item.type == "enum" and options(item) or nil,
            modified = read()[item.key] ~= nil,
          }
        end, s.items),
      }
    end, M.SCHEMA),
    devices = devices or vim.NIL,
    leader = vim.g.mapleader or "\\",
    -- The terminal colors, for the color picker's swatches.
    palette = vim.iter(vim.fn.range(0, 15)):map(function(i) return vim.g["terminal_color_" .. i] end):totable(),
  }
end

local function render_text()
  local lines, map = {}, {}
  for _, s in ipairs(M.SCHEMA) do
    if #lines > 0 then table.insert(lines, "") end
    table.insert(lines, s.section)
    for _, item in ipairs(s.items) do
      table.insert(lines, ("  %-38s %s%s"):format(item.label, shown(get(item), item), read()[item.key] ~= nil and "  *" or ""))
      map[#lines] = item.key
    end
  end
  if devices then
    table.insert(lines, "")
    table.insert(lines, "Devices")
    table.insert(lines, ("  %-38s %s"):format("Address", devices.url))
    map[#lines] = "devices.url"
    for _, d in ipairs(devices.devices) do
      local what = {}
      if d.leader then table.insert(what, "leader") end
      table.insert(what, d.connected and "connected" or d.seen > 0 and os.date("seen %Y-%m-%d %H:%M", math.floor(d.seen / 1000)) or "away")
      table.insert(lines, ("  %-38s %s"):format(d.name .. (d.me and " (this machine)" or ""), table.concat(what, ", ")))
      map[#lines] = "devices." .. d.device
    end
  end
  pinned.set_lines(buf, lines)
  line_key = map
  if not selected or not pinned.line_of(map, selected) then selected = map[2] end
  pinned.follow(buf, line_key, selected)
end

local function push()
  if buf and vim.api.nvim_buf_is_valid(buf) then
    render_text()
    ui().notify("corkboard.view", buf, state())
  end
end

-- Set a setting, from the page or the keys below. vim.NIL or nil puts it
-- back to its default (the colorscheme's, for a color).
function M.set(key, v)
  local item = by_key[key]
  if not item then return end
  if v == vim.NIL then v = nil end
  if item.type == "number" and v ~= nil then v = tonumber(v) end
  read()[key] = v
  write()
  local ok, err = pcall(apply, item, v == nil and item.default or v)
  if not ok then vim.notify("corkboard: " .. item.label .. ": " .. tostring(err), vim.log.levels.ERROR) end
  push()
end

-- A click on a setting: the cursor to it, in the window clicked in.
function M.select(key, win)
  selected = key
  local lnum = pinned.line_of(line_key, key)
  if lnum and vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_set_cursor(win, { lnum, 2 }) end
  push()
end

-- The devices from the bridge, after op (nodes_list, or nodes_leader with
-- a device or vim.NIL), redrawn when they come.
local function load_devices(op, ...)
  require("corkboard.cards.cloud").call_async(op or "nodes_list", function(err, res)
    vim.schedule(function()
      if err then return vim.notify("corkboard: devices: " .. tostring(err), vim.log.levels.WARN) end
      devices = res ~= vim.NIL and res or nil
      push()
    end)
  end, ...)
end

-- A device's line: it leads, or with the leader's, none does. The address's: copied.
function M.device(key)
  if not devices then return end
  if key == "devices.url" then
    vim.fn.setreg("+", devices.url)
    return vim.notify("corkboard: copied " .. devices.url)
  end
  local id = key:match("^devices%.(.+)")
  if id then load_devices("nodes_leader", id == devices.leader and vim.NIL or id) end
end

-- The cursor's setting, changed as a bare Neovim can: on/off flips, a
-- choice is picked, the rest are typed.
local function edit()
  if selected and selected:match("^devices%.") then return M.device(selected) end
  local item = by_key[selected]
  if not item then return end
  local v = get(item)
  if item.type == "bool" then return M.set(item.key, not v) end
  if item.type == "enum" then
    return vim.ui.select(options(item), {
      prompt = item.label,
      format_item = function(o) return o.label end,
    }, function(o) if o then M.set(item.key, o.value) end end)
  end
  local sep = item.type == "keys" and " " or ", "
  local text = v == nil and "" or (item.type == "list" or item.type == "keys") and table.concat(v, sep) or tostring(v)
  vim.ui.input({ prompt = item.label .. ": ", default = text }, function(input)
    if input == nil then return end
    if input == "" then return M.set(item.key, nil) end
    if item.type == "list" then return M.set(item.key, vim.split(input, "%s*,%s*", { trimempty = true })) end
    if item.type == "keys" then return M.set(item.key, vim.split(input, "%s+", { trimempty = true })) end
    M.set(item.key, input)
  end)
end

local function buffer()
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  buf = pinned.listing("agent://settings", "settings", {
    j = { function() pinned.step(line_key, 1) end, "next setting" },
    k = { function() pinned.step(line_key, -1) end, "previous setting" },
    ["<CR>"] = { edit, "change it" },
    x = { function() M.set(selected, nil) end, "back to its default" },
  }, function() return line_key end, function(key)
    if key == selected then return end
    selected = key
    push()
  end)
  return buf
end

-- The tab, a new one after this, or where it's open.
function M.open()
  local b = buffer()
  local win = vim.fn.win_findbuf(b)[1]
  if win then
    vim.api.nvim_set_current_win(win)
  else
    vim.cmd("tabnew")
    local empty = vim.api.nvim_get_current_buf()
    vim.api.nvim_win_set_buf(0, b)
    pcall(vim.api.nvim_buf_delete, empty, {})
  end
  push()
  load_devices()
end

-- Keybindings ------------------------------------------------------------------

local MODES = { "n", "i", "t", "x", "c" }

-- What each binding is bound to, for the menu bar's keys, and every Cmd
-- chord mapped at all, which a Mac's page sends on (input.js) rather than
-- leaving to the browser.
function M.push_keys()
  local bindings, cmd = {}, {}
  for _, item in pairs(by_key) do
    if item.type == "keys" then bindings[item.label:lower()] = item.get() end
  end
  for _, mode in ipairs(MODES) do
    for _, m in ipairs(vim.api.nvim_get_keymap(mode)) do
      if m.lhs:find("D%-") then cmd[m.lhs] = true end
    end
  end
  ui().notify("corkboard.keys", { bindings = bindings, cmd = vim.tbl_keys(cmd) })
end

-- One shortcut's mappings, as init.lua made them: rebound, each new key gets
-- every mode any of them had, with that mode's first one's action.
local function binding(label, maps, keys)
  local bound = vim.deepcopy(maps)
  local function map(mode, lhs, m)
    vim.keymap.set(mode, lhs, m.rhs, m.opts)
    table.insert(bound, { mode = mode, lhs = lhs })
  end
  return {
    key = "keys." .. label,
    label = label:sub(1, 1):upper() .. label:sub(2),
    type = "keys",
    default = keys,
    get = function()
      local current = {}
      for _, b in ipairs(bound) do
        if not vim.tbl_contains(current, b.lhs) then table.insert(current, b.lhs) end
      end
      return current
    end,
    set = function(v)
      for _, b in ipairs(bound) do pcall(vim.keymap.del, b.mode, b.lhs) end
      bound = {}
      if v == nil or vim.deep_equal(v, keys) then
        for _, m in ipairs(maps) do map(m.mode, m.lhs, m) end
        return
      end
      local first, modes = {}, {}
      for _, m in ipairs(maps) do
        if not first[m.mode] then
          first[m.mode] = m
          table.insert(modes, m.mode)
        end
      end
      for _, lhs in ipairs(v) do
        for _, mode in ipairs(modes) do map(mode, lhs, first[mode]) end
      end
    end,
  }
end

-- The Keybindings section, from the mappings init.lua has made by now, with
-- what was saved for them applied.
function M.keys()
  local leader = vim.g.mapleader or "\\"
  local maps, keys, labels = {}, {}, {}
  for _, mode in ipairs(MODES) do
    local list = vim.api.nvim_get_keymap(mode)
    -- Newest first, within keys that start alike: as they were made.
    for i = #list, 1, -1 do
      local m = list[i]
      local label = m.desc and m.desc:match("^corkboard: (.+)")
      if label then
        if not maps[label] then
          maps[label], keys[label] = {}, {}
          table.insert(labels, label)
        end
        local lhs = m.lhs:sub(1, #leader) == leader and "<leader>" .. m.lhs:sub(#leader + 1) or m.lhs
        table.insert(maps[label], {
          mode = mode,
          lhs = lhs,
          rhs = m.callback or m.rhs,
          opts = { desc = m.desc, expr = m.expr == 1, silent = m.silent == 1, nowait = m.nowait == 1, remap = m.noremap ~= 1 },
        })
        if not vim.tbl_contains(keys[label], lhs) then table.insert(keys[label], lhs) end
      end
    end
  end
  table.sort(labels)
  local items = {}
  for _, label in ipairs(labels) do
    local item = binding(label, maps[label], keys[label])
    by_key[item.key] = item
    table.insert(items, item)
  end
  for i = #M.SCHEMA, 1, -1 do
    if M.SCHEMA[i].section == "Keybindings" then table.remove(M.SCHEMA, i) end
  end
  table.insert(M.SCHEMA, { section = "Keybindings", items = items })
  for key, v in pairs(read()) do
    local item = by_key[key]
    if item and item.type == "keys" then
      local ok, err = pcall(item.set, v)
      if not ok then vim.notify("corkboard: settings: " .. key .. ": " .. tostring(err), vim.log.levels.WARN) end
    end
  end
end

-- The zoom a step in (dir 1) or out (-1) from where it is, or 100% (0).
function M.zoom(dir)
  local now, to = vim.g.corkboard_zoom or 100, 100
  if dir > 0 then
    to = ZOOM[#ZOOM]
    for _, z in ipairs(ZOOM) do
      if z > now then
        to = z
        break
      end
    end
  elseif dir < 0 then
    to = ZOOM[1]
    for i = #ZOOM, 1, -1 do
      if ZOOM[i] < now then
        to = ZOOM[i]
        break
      end
    end
  end
  M.set("zoom", to ~= 100 and to or nil)
end

-- For a channel that just attached, or the colorscheme changing.
function M.push_all()
  push()
  M.push_keys()
end

function M.setup()
  for key, v in pairs(read()) do
    local item = by_key[key]
    -- Keybindings wait for M.keys.
    if item then
      local ok, err = pcall(apply, item, v)
      if not ok then vim.notify("corkboard: settings: " .. key .. ": " .. tostring(err), vim.log.levels.WARN) end
    end
  end
  vim.api.nvim_create_user_command("AgentSettings", M.open, { desc = "corkboard: settings" })
  vim.keymap.set({ "n", "i", "t" }, "<C-,>", M.open, { desc = "corkboard: settings" })
  vim.keymap.set({ "n", "i", "t" }, "<D-,>", M.open, { desc = "corkboard: settings" })
  -- VS Code's zoom keys, its numpad ones too.
  local modes = { "n", "i", "t", "x", "c" }
  local zoom = {
    { 1, "zoom in", { "<C-=>", "<C-+>", "<D-=>", "<D-S-=>" } },
    { -1, "zoom out", { "<C-->", "<D-->" } },
    { 0, "reset zoom", { "<C-k0>", "<D-k0>" } },
  }
  for _, z in ipairs(zoom) do
    for _, lhs in ipairs(z[3]) do
      vim.keymap.set(modes, lhs, function() M.zoom(z[1]) end, { desc = "corkboard: " .. z[2] })
    end
  end
end

return M
