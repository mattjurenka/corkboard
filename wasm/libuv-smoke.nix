# Runs tests/libuv-smoke.c under node against the wasm libuv.
{ runCommand, emscripten, emcache, nodejs, wasmDeps }:

runCommand "libuv-smoke" { nativeBuildInputs = [ emscripten nodejs ]; } ''
  export EM_CACHE=$TMPDIR/emcache
  cp -r ${emcache} $EM_CACHE
  chmod -R u+w $EM_CACHE

  emcc -O1 -I${wasmDeps}/include ${./tests/libuv-smoke.c} \
    ${wasmDeps}/lib/libuv.a -o smoke.js
  node smoke.js | tee $out
''
