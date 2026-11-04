-- Which of corkboard's parts are on (Settings > Features), both off unless
-- turned on, so a new install is the board and brains:
--
--   fleet       agents spawned onto other machines: the Fleet tab (third,
--               before brains), holds, and a brain's account and credentials
--   assistant   the day plan, meetings, and Pepper's advice on usage
--
-- Each is vim.g.corkboard_<name>. changed() puts the pinned tabs right and
-- tells the page, which hides what's off (corkboard.features).

local M = {}

function M.on(name) return vim.g["corkboard_" .. name] == true end

function M.push()
  require("corkboard").notify("corkboard.features", { fleet = M.on("fleet"), assistant = M.on("assistant") })
end

-- After a setting changed: the fleet's tab made or closed, brains moved to
-- follow it, and the page told.
function M.changed()
  vim.schedule(function()
    local ui = require("corkboard")
    if ui.window ~= "plan" and vim.v.vim_did_enter == 1 then
      if M.on("fleet") then
        require("corkboard.fleet").ensure()
      else
        require("corkboard.pinned").drop("corkboard_fleet")
      end
      require("corkboard.brains").ensure()
    end
    M.push()
  end)
end

return M
