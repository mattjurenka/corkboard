# Neovim compiled to wasm with Emscripten, for the page's ?wasm mode
# (web/src/nvim/wasm). Each stage is one derivation:
#
#   emcache     emscripten's system libraries, prebuilt once
#   libuvSrc    libuv with the emscripten port (patches/libuv-emscripten.patch)
#   wasmDeps    neovim's dependency bundle, cross-compiled; PUC Lua 5.1 in
#               place of LuaJIT, since wasm has no JIT
#   nvim-host   native neovim from the same source: its code generators and
#               runtime files, which the wasm binary can't make for itself
#   nvim-wasm   nvim.{js,wasm,data} for a Web Worker (the page's)
#   nvim-wasm-node  the same under node with the host's files, for the tests
#
# `pkgs` is nixpkgs pinned apart from the rest (flake.nix's nixpkgs-wasm):
# emscripten and the builds on it take hours, and should not redo them on
# every nixpkgs update.
{ pkgs, neovim-src, nvimVersion }:

let
  pkgs' = pkgs.extend (final: prev: {
    # fstat on stdio under NODERAWFS, for the node build.
    emscripten = prev.emscripten.overrideAttrs (old: {
      patches = (old.patches or [ ]) ++ [ ./patches/emscripten-noderawfs-fstat.patch ];
    });
  });
  call = pkgs'.lib.callPackageWith (pkgs' // packages // { inherit neovim-src nvimVersion depsSources; });
  depsSources = call ./deps-sources.nix { };
  packages = {
    emcache = call ./emcache.nix { };
    libuvSrc = call ./libuv-src.nix { };
    nvim-host = call ./nvim-host.nix { };
    wasmDeps = call ./wasm-deps.nix { };
    nvim-wasm = call ./nvim-wasm.nix { variant = "web"; };
    nvim-wasm-node = call ./nvim-wasm.nix { };
  };
in
{
  inherit packages;
  checks = {
    libuv-smoke = call ./libuv-smoke.nix { };
    nvim-smoke = call ./nvim-smoke.nix { nvim-wasm = packages.nvim-wasm-node; };
  };
  # `nix develop .#wasm`: emscripten, cmake and ninja, for working on the
  # libuv port or neovim's source by hand.
  shell = pkgs'.mkShell {
    inputsFrom = [ packages.wasmDeps ];
    packages = [ pkgs'.nodejs ];
    NEOVIM_SRC = neovim-src;
    WASM_DEPS = packages.wasmDeps;
    NVIM_HOST = packages.nvim-host;
    HOST_LUAJIT = "${packages.nvim-host.lua}/bin/luajit";
    shellHook = ''
      # emscripten needs a writable cache; seeded from the prebuilt one.
      export EM_CACHE="$(git rev-parse --show-toplevel)/wasm/.emcache"
      if [ ! -d "$EM_CACHE" ]; then
        cp -r ${packages.emcache} "$EM_CACHE"
        chmod -R u+w "$EM_CACHE"
      fi
    '';
  };
}
