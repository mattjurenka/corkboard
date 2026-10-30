# Runs tests/smoke.lua inside the wasm neovim under node.
{ runCommand, nvim-wasm }:

runCommand "nvim-smoke" { } ''
  export HOME=$TMPDIR
  ${nvim-wasm}/bin/nvim-wasm -u NONE -i NONE -es \
    -c 'luafile ${./tests/smoke.lua}' </dev/null | tee $out
''
