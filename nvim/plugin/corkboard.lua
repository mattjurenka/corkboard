if vim.g.loaded_corkboard then return end
vim.g.loaded_corkboard = true

-- A Neovim in the page (corkboard.wasm) gets its processes first.
if vim.g.corkboard_wasm then require("corkboard.wasm").setup() end
require("corkboard").setup()
