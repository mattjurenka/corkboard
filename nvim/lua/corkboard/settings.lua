-- The Settings tab (File > Settings, Ctrl+, or :AgentSettings): every setting
-- declared once below, with its type, which the page picks a control by.
-- What's changed is kept in ~/.config/corkboard/settings.json and applied at
-- setup, over whatever init.lua set, to the vim.g variable or option the
-- setting stands for, so what reads it is unchanged.
--
-- A plain listing, agent://settings, with the browser's HTML drawn over it.
-- The cursor's line selects; <CR> changes the setting (toggles, picks or asks
-- for it) and x puts it back to its default.

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

-- type: text, number, bool, color, enum (options: values, or { value,
-- label }s, or a function returning them) or list (of text). A setting
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
      vim.tbl_extend("error", { key = "number", label = "Line numbers", type = "bool", default = true }, option("number")),
      vim.tbl_extend("error", { key = "relativenumber", label = "Relative line numbers", type = "bool", default = true }, option("relativenumber")),
      vim.tbl_extend("error", { key = "wrap", label = "Wrap lines", type = "bool", default = true }, option("wrap")),
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

local function shown(v, item)
  if v == nil then return item.placeholder or "" end
  if item.type == "bool" then return v and "on" or "off" end
  if item.type == "list" then return table.concat(v, ", ") end
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

-- The cursor's setting, changed as a bare Neovim can: on/off flips, a
-- choice is picked, the rest are typed.
local function edit()
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
  local text = v == nil and "" or item.type == "list" and table.concat(v, ", ") or tostring(v)
  vim.ui.input({ prompt = item.label .. ": ", default = text }, function(input)
    if input == nil then return end
    if input == "" then return M.set(item.key, nil) end
    if item.type == "list" then return M.set(item.key, vim.split(input, "%s*,%s*", { trimempty = true })) end
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
end

-- For a channel that just attached, or the colorscheme changing.
function M.push_all() push() end

function M.setup()
  for key, v in pairs(read()) do
    local item = by_key[key]
    if item then
      local ok, err = pcall(apply, item, v)
      if not ok then vim.notify("corkboard: settings: " .. key .. ": " .. tostring(err), vim.log.levels.WARN) end
    end
  end
  vim.api.nvim_create_user_command("AgentSettings", M.open, { desc = "corkboard: settings" })
  vim.keymap.set({ "n", "i", "t" }, "<C-,>", M.open, { desc = "corkboard: settings" })
  vim.keymap.set({ "n", "i", "t" }, "<D-,>", M.open, { desc = "corkboard: settings" })
end

return M
