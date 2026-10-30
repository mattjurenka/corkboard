# Native neovim from the same source as the wasm build. The wasm build runs
# its code generators on the host with this build's lib/libnlua0.so and the
# LuaJIT it was built against (passthru.lua).
{ neovim-unwrapped, neovim-src, nvimVersion }:

neovim-unwrapped.overrideAttrs (old: {
  version = nvimVersion;
  src = neovim-src;

  postInstall = (old.postInstall or "") + ''
    install -Dm755 lib/libnlua0.so $out/lib/libnlua0.so
  '';
})
