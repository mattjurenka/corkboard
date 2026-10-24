{
  description = "corkboard: Neovim in the browser, with agent panels beside it";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
      # Plugins the bridge puts on Neovim's runtimepath.
      pluginPath = pkgs: pkgs.lib.concatStringsSep ":" [ pkgs.vimPlugins.snacks-nvim ];
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.neovim pkgs.bun pkgs.ripgrep pkgs.fd ];
          CORKBOARD_PLUGINS = pluginPath pkgs;
        };
      });

      # The bridge, the web page and the Neovim plugin, laid out as in the repo
      # so server.ts finds ../web and ../nvim from its own path. Exposes
      # `corkboard-bridge`; the CORKBOARD_* variables still apply, and
      # plugins given in CORKBOARD_PLUGINS come before snacks.nvim.
      packages = forAll (pkgs: rec {
        # What building the page needs (React, Vite, Tailwind), from bun.lock.
        # A fixed-output derivation so bun can reach the registry; the hash
        # changes with bun.lock, and differs per system because Vite and
        # Tailwind bring native binaries for the one they run on.
        webDeps = pkgs.stdenvNoCC.mkDerivation {
          pname = "corkboard-web-deps";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./package.json ./bun.lock ];
          };
          nativeBuildInputs = [ pkgs.bun ];
          impureEnvVars = pkgs.lib.fetchers.proxyImpureEnvVars;
          buildPhase = ''
            export HOME=$TMPDIR
            bun install --frozen-lockfile --ignore-scripts --no-progress
          '';
          installPhase = "cp -r node_modules $out";
          dontFixup = true;
          outputHashMode = "recursive";
          outputHash = {
            x86_64-linux = "sha256-ThtesmVbru/WWHaKp5LUrHRXq4eR6Zpy/3NR9pMVG8c=";
          }.${pkgs.stdenv.hostPlatform.system} or pkgs.lib.fakeHash;
        };

        # The page as the bridge serves it (web/dist).
        web = pkgs.stdenvNoCC.mkDerivation {
          pname = "corkboard-web";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./package.json ./tsconfig.json ./web/index.html ./web/vite.config.ts ./web/src ./web/public ];
          };
          nativeBuildInputs = [ pkgs.bun ];
          buildPhase = ''
            export HOME=$TMPDIR
            cp -r ${webDeps} node_modules
            chmod -R u+w node_modules
            bun --bun node_modules/.bin/vite build web
          '';
          installPhase = "cp -r web/dist $out";
        };

        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "corkboard";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./bridge ./nvim ./mcp ];
          };
          # The bridge's only dependency, and it has none of its own, so it is fetched
          # straight from the registry with bun.lock's integrity hash instead
          # of running a package manager in the build.
          msgpack = pkgs.fetchurl {
            url = "https://registry.npmjs.org/@msgpack/msgpack/-/msgpack-3.1.3.tgz";
            hash = "sha512-47XIizs9XZXvuJgoaJUIE2lFoID8ugvc0jzSHP+Ptfk8nTbnR8g788wv48N03Kx0UkAv559HWRQ3yzOgzlRNUA==";
          };
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            share=$out/share/corkboard
            mkdir -p $share/node_modules/@msgpack/msgpack
            cp -r bridge nvim mcp $share/
            mkdir -p $share/web && cp -r ${web} $share/web/dist
            tar -xzf $msgpack -C $share/node_modules/@msgpack/msgpack --strip-components=1
            makeWrapper ${pkgs.lib.getExe pkgs.bun} $out/bin/corkboard-bridge \
              --add-flags $share/bridge/server.ts \
              --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.neovim pkgs.bun pkgs.ripgrep pkgs.fd ]} \
              --suffix CORKBOARD_PLUGINS : ${pluginPath pkgs}
          '';
          meta.mainProgram = "corkboard-bridge";
        };

        # The Neovim plugin alone, for a Neovim the bridge runs on another
        # machine over ssh (CORKBOARD_REMOTES): it goes there with nix copy,
        # and the bridge and bun do not need to.
        plugin = pkgs.runCommand "corkboard-nvim-plugin" { } ''
          cp -r ${./nvim} $out
        '';
      });
    };
}
