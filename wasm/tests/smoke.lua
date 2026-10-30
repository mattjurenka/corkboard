-- Headless smoke test for wasm neovim. Run with:
--   nvim -u NONE -i NONE -es -c 'luafile smoke.lua'
-- Prints "ok <name>" per check and exits non-zero on any failure.
local failures = 0
local function check(name, fn)
  local ok, res = pcall(fn)
  if ok and res then
    io.stdout:write('ok ' .. name .. '\n')
  else
    io.stdout:write('FAIL ' .. name .. ' ' .. tostring(res) .. '\n')
    failures = failures + 1
  end
end

check('lua-version', function() return _VERSION == 'Lua 5.1' end)
check('vimscript-eval', function() return vim.fn.eval('1 + 2 * 3') == 7 end)
check('buffer-edit', function()
  vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'hello', 'world' })
  vim.cmd('%s/o/0/g')
  local l = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  return l[1] == 'hell0' and l[2] == 'w0rld'
end)
check('normal-mode', function()
  vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'abc' })
  vim.o.undolevels = vim.o.undolevels -- break the undo sequence
  vim.cmd('normal! gg$x')
  return vim.api.nvim_get_current_line() == 'ab'
end)
check('undo', function()
  vim.cmd('normal! u')
  return vim.api.nvim_get_current_line() == 'abc'
end)
check('regex', function() return vim.fn.matchstr('foo123bar', '\\d\\+') == '123' end)
check('lpeg', function() return vim.lpeg.match(vim.lpeg.R('az') ^ 1, 'abc1') == 4 end)
check('json', function() return vim.json.decode(vim.json.encode({ a = { 1, 2 } })).a[2] == 2 end)
check('mpack', function() return vim.mpack.decode(vim.mpack.encode({ x = 'y' })).x == 'y' end)
check('uv-hrtime', function() return vim.uv.hrtime() > 0 end)
check('uv-timer', function()
  local fired = false
  vim.defer_fn(function() fired = true end, 20)
  return vim.wait(1000, function() return fired end)
end)
check('fs-roundtrip', function()
  local f = vim.fn.tempname()
  vim.fn.writefile({ 'one', 'two' }, f)
  return vim.fn.readfile(f)[2] == 'two'
end)
check('write-read-buffer', function()
  local f = vim.fn.tempname()
  vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'saved' })
  vim.cmd('silent write ' .. f)
  vim.cmd('enew!')
  vim.cmd('silent edit ' .. f)
  return vim.api.nvim_get_current_line() == 'saved'
end)
check('utf8', function() return vim.fn.strchars('héllo→') == 6 and vim.fn.strwidth('日本') == 4 end)
check('vim.iter', function()
  return vim.iter({ 1, 2, 3 }):map(function(x) return x * 2 end):totable()[3] == 6
end)

vim.cmd(failures == 0 and 'qa!' or 'cq ' .. failures)
