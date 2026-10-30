# libuv with the emscripten port applied, repacked as a tarball so neovim's
# cmake.deps can consume it through LIBUV_URL like any other dependency.
{ stdenvNoCC, depsSources }:

stdenvNoCC.mkDerivation {
  name = "libuv-emscripten.tar.gz";
  src = depsSources.LIBUV;
  patches = [ ./patches/libuv-emscripten.patch ];

  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    cd ..
    tar --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
      -czf $out "$(basename "$OLDPWD")"
  '';
}
