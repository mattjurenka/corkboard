# Neovim's dependency bundle cross-compiled with emscripten, built by
# neovim's own cmake.deps with every download replaced by a store path.
# LuaJIT can't JIT on wasm, so PUC Lua 5.1 stands in for it.
{ lib, stdenv, emscripten, emcache, cmake, ninja, gnumake, neovim-src, nvimVersion
, depsSources, libuvSrc }:

let
  urlFlags = lib.concatStringsSep " " (lib.mapAttrsToList
    (name: src: "-D${name}_URL=${src}")
    (lib.filterAttrs (_: lib.isDerivation) depsSources // { LIBUV = libuvSrc; }));
in
stdenv.mkDerivation {
  pname = "neovim-wasm-deps";
  version = nvimVersion;
  src = neovim-src;

  nativeBuildInputs = [ emscripten cmake ninja gnumake ];
  dontUseCmakeConfigure = true;
  dontUseNinjaBuild = true;
  dontUseNinjaInstall = true;

  configurePhase = ''
    runHook preConfigure
    export EM_CACHE=$TMPDIR/emcache
    cp -r ${emcache} $EM_CACHE
    chmod -R u+w $EM_CACHE

    emcmake cmake -S cmake.deps -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DUSE_BUNDLED_LUAJIT=OFF -DUSE_BUNDLED_LUA=ON \
      -DUSE_BUNDLED_TS_PARSERS=OFF \
      -DUSE_BUNDLED_GETTEXT=OFF -DUSE_BUNDLED_LIBICONV=OFF \
      -DDEPS_CMAKE_CACHE_ARGS="-DCMAKE_FIND_ROOT_PATH:PATH=$PWD/build/usr" \
      ${urlFlags} \
      -DLIBUV_SHA256=$(sha256sum ${libuvSrc} | cut -d' ' -f1)
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    cmake --build build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -r build/usr $out
    # Lua's Makefile archives with host ar, which can't index wasm objects.
    for a in $out/lib/*.a; do emranlib "$a"; done
    runHook postInstall
  '';
}
