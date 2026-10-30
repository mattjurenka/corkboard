# Neovim cross-compiled to wasm. Code generators run on the host via
# nvim-host's libnlua0 and LuaJIT; the platform-independent runtime files
# (help tags, generated syntax) are taken from nvim-host instead of running
# the wasm binary during the build.
#
# variant "node": NODERAWFS gives it the host filesystem; for the tests.
# variant "web":  runs in a Web Worker (web/src/nvim/wasm/pre.js) with the
#                 runtime preloaded into an in-memory filesystem (nvim.data).
{ lib, stdenv, emscripten, emcache, cmake, ninja, nodejs, makeWrapper
, neovim-src, nvimVersion, wasmDeps, nvim-host, variant ? "node" }:

assert lib.elem variant [ "node" "web" ];

let
  runtime = "${nvim-host}/share/nvim/runtime";

  common = [
    "-sALLOW_MEMORY_GROWTH=1"
    "-sSTACK_SIZE=8MB"
    "--profiling-funcs"
  ];
  linkFlags = lib.concatStringsSep " " (common ++ {
    node = [
      "-sNODERAWFS=1"
      "--pre-js=${./node-env.js}"
    ];
    web = [
      "-sENVIRONMENT=worker"
      "-sEXIT_RUNTIME=1" # so exit() reaches Module.onExit
      "-sFORCE_FILESYSTEM=1"
      "--pre-js=${../web/src/nvim/wasm/pre.js}"
      "--preload-file=${runtime}@/usr/share/nvim/runtime"
    ];
  }.${variant});
in
stdenv.mkDerivation {
  pname = "neovim-wasm-${variant}";
  version = nvimVersion;
  src = neovim-src;

  nativeBuildInputs = [ emscripten cmake ninja makeWrapper ];
  dontUseCmakeConfigure = true;
  dontUseNinjaBuild = true;
  dontUseNinjaInstall = true;

  configurePhase = ''
    runHook preConfigure
    export EM_CACHE=$TMPDIR/emcache
    cp -r ${emcache} $EM_CACHE
    chmod -R u+w $EM_CACHE

    # COMPILE_LUA=OFF: host LuaJIT bytecode can't be loaded by PUC Lua.
    # LUA_MATH_LIBRARY: emscripten's libm lives in libc; STRING keeps cmake
    # from turning -lm into a path. Link flags go in the _RELEASE variant so
    # cmake's try_compile checks don't link with them.
    emcmake cmake -S . -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DDEPS_PREFIX=${wasmDeps} -DCMAKE_FIND_ROOT_PATH=${wasmDeps} \
      -DPREFER_LUA=ON -DCOMPILE_LUA=OFF -DENABLE_LIBINTL=OFF \
      -DLUA_PRG=${nvim-host.lua}/bin/luajit \
      -DLUA_GEN_PRG=${nvim-host.lua}/bin/luajit \
      -DNLUA0_HOST_PRG=${nvim-host}/lib/libnlua0.so \
      -DLUA_MATH_LIBRARY:STRING=-lm \
      -DCMAKE_EXE_LINKER_FLAGS_RELEASE="${linkFlags}"
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    cmake --build build --target nvim_bin
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 -t $out/lib/nvim-wasm build/bin/nvim.*
  '' + lib.optionalString (variant == "node") ''
    # Built-in ftplugins start tree-sitter, and no parsers are bundled.
    makeWrapper ${nodejs}/bin/node $out/bin/nvim-wasm \
      --add-flags "$out/lib/nvim-wasm/nvim.js --cmd 'filetype plugin off'" \
      --set-default VIMRUNTIME ${runtime}
  '' + ''
    runHook postInstall
  '';
}
