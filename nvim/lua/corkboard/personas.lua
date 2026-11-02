-- Who a session's avatar is (corkboard.avatar): its brain's persona
-- (cloud/src/brains.ts), else the default. The page has each one's model,
-- voice and lines (web/src/avatar/personas.ts, by the same ids); here is
-- how each talks, which the session is told while it's heard.

local M = {}

M.DEFAULT = "tsundere"

M.IDS = { "tsundere", "bikini", "businesswoman" }

local SPEAKS = {
  tsundere = "You speak as a tsundere: prickly, quick to huff and deny you care, caring anyway and letting it slip;"
    .. " a little flustered by praise.",
  bikini = "You speak as a sunny, cheeky beach girl: warm, playful and upbeat, teasing gently,"
    .. " now and then a beach or holiday turn of phrase.",
  businesswoman = "You speak as a composed, efficient executive: crisp and to the point, polite,"
    .. " with a dry wit and the odd bit of office jargon used knowingly.",
}

function M.id(id)
  return SPEAKS[id] and id or M.DEFAULT
end

-- How a persona talks, for what's said aloud.
function M.speaks(id)
  return SPEAKS[M.id(id)]
end

return M
