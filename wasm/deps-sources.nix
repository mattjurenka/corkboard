# Dependency tarballs, fetched from the URLs and hashes pinned in neovim's
# own cmake.deps/deps.txt so they always match the neovim source.
{ lib, fetchurl, neovim-src }:

let
  lines = lib.splitString "\n" (builtins.readFile "${neovim-src}/cmake.deps/deps.txt");
  entries = map (lib.splitString " ")
    (lib.filter (l: l != "" && !lib.hasPrefix "#" l) lines);
  pins = lib.listToAttrs (map (e: lib.nameValuePair (lib.elemAt e 0) (lib.elemAt e 1)) entries);

  fetchDep = name: fetchurl {
    url = pins."${name}_URL";
    sha256 = pins."${name}_SHA256";
  };
in
lib.genAttrs [
  "LIBUV" "LUA" "LPEG" "LUV" "LUA_COMPAT53" "UNIBILIUM" "UTF8PROC" "TREESITTER"
] fetchDep
