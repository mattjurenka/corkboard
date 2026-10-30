# Emscripten keeps compiled system libraries (libc, libc++, ...) in a
# writable cache. Prebuild them once here so every wasm derivation and the
# dev shell can start from a copy instead of recompiling libc each time.
{ stdenvNoCC, emscripten }:

stdenvNoCC.mkDerivation {
  name = "emscripten-cache-${emscripten.version}";
  nativeBuildInputs = [ emscripten ];
  dontUnpack = true;

  buildPhase = ''
    export EM_CACHE=$PWD/cache
    cp -r ${emscripten}/share/emscripten/cache $EM_CACHE
    chmod -R u+w $EM_CACHE
    embuilder build libc libc++ libc++abi libdlmalloc libclang_rt.builtins \
      libstubs libnoexit libsockets
  '';

  installPhase = ''
    cp -r cache $out
  '';
}
