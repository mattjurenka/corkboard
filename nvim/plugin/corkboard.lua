if vim.g.loaded_corkboard then return end
vim.g.loaded_corkboard = true

require("corkboard").setup()
