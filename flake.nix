{
  description = "corkboard: Neovim in the browser, with agent panels beside it";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
      # Pepper's VM on the droplet: its addresses, shared by the guest and
      # the droplet's half (fleet/pepper/).
      pepperPlan = import ./fleet/plan.nix { name = "pepper-vm"; interface = "pep0"; octet = 89; mac = "52:54:00:c1:a0:30"; };
      # Plugins the bridge puts on Neovim's runtimepath.
      pluginPath = pkgs: pkgs.lib.concatStringsSep ":" [ pkgs.vimPlugins.snacks-nvim ];
    in
    {
      # The agent VMs (fleet/, and .agent/plans/agent-fleet.md). A host that
      # runs them imports `fleetHost` and sets `my.agentVms`; `mkPlan` makes
      # the address plan each VM and the host share; `mkFleet` turns brains,
      # capabilities, environments and templates into checked guests.
      nixosModules.fleetHost = { pkgs, lib, ... }: {
        imports = [ ./fleet/host/host.nix ];
        my.agentVms.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.fleet;
      };
      lib.fleet = {
        mkPlan = import ./fleet/plan.nix;
        # Claude Code hooks that give a guest's sessions its brain's memory.
        memoryHooks = import ./fleet/memory-hooks.nix;
        inherit (import ./fleet/lib.nix { inherit (nixpkgs) lib; }) mkFleet capabilities;
      };

      nixosConfigurations.pepper-vm = nixpkgs.lib.nixosSystem {
        modules = [ (import ./fleet/pepper/guest.nix { plan = pepperPlan; memoryHooks = import ./fleet/memory-hooks.nix; }) ];
      };

      checks = forAll (pkgs: {
        fleet = import ./fleet/tests.nix { inherit pkgs; inherit (pkgs) lib; };
      });

      devShells = forAll (pkgs:
        let
          # The phone app (android/): `nix develop .#android`, then
          # `gradle -p android assembleDebug`. The SDK is unfree and needs
          # its license accepted. `.#android-emulator` adds an emulator and
          # an Android 15 image, to run it without a phone.
          pkgs' = import nixpkgs {
            system = pkgs.stdenv.hostPlatform.system;
            config = { allowUnfree = true; android_sdk.accept_license = true; };
          };
          androidShell = emulator:
            let
              sdk = (pkgs'.androidenv.composeAndroidPackages ({
                platformVersions = [ "35" ];
                buildToolsVersions = [ "35.0.0" ];
                includeNDK = false;
                includeEmulator = emulator;
              } // pkgs.lib.optionalAttrs emulator {
                includeSystemImages = true;
                systemImageTypes = [ "google_apis" ];
                abiVersions = [ "x86_64" ];
              })).androidsdk;
              home = "${sdk}/libexec/android-sdk";
            in
            pkgs'.mkShell {
              packages = [ sdk pkgs'.jdk17 pkgs'.gradle ];
              ANDROID_HOME = home;
              ANDROID_SDK_ROOT = home;
              JAVA_HOME = pkgs'.jdk17.home;
              # Gradle's own aapt2 from Maven is linked for other distros.
              GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${home}/build-tools/35.0.0/aapt2";
            };
        in
        {
          default = pkgs.mkShell {
            packages = [ pkgs.neovim pkgs.bun pkgs.ripgrep pkgs.fd pkgs.electron ];
            CORKBOARD_PLUGINS = pluginPath pkgs;
          };
          android = androidShell false;
          android-emulator = androidShell true;
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
            x86_64-linux = "sha256-X2ponyGENHb5U2owd/x1tCr23VayW2thj1GQMnSdMLA=";
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
            # A brain's vault into its memory in the Worker (bridge/memory-sync.ts).
            makeWrapper ${pkgs.lib.getExe pkgs.bun} $out/bin/corkboard-memory-sync \
              --add-flags $share/bridge/memory-sync.ts
          '';
          meta.mainProgram = "corkboard-bridge";
        };

        # The desktop window (app/main.js): nixpkgs' Electron on the bridge's
        # page. `corkboard-app [--name ID] [--title NAME] URL`; ID is the
        # window's app_id and wants a desktop entry of the same name.
        app = pkgs.stdenvNoCC.mkDerivation {
          pname = "corkboard-app";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./app ./web/public/logo.svg ./web/public/icon-512.png ];
          };
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            mkdir -p $out/share/corkboard-app $out/share/icons/hicolor/scalable/apps $out/share/icons/hicolor/512x512/apps
            cp app/* $out/share/corkboard-app/
            cp web/public/logo.svg $out/share/icons/hicolor/scalable/apps/corkboard.svg
            cp web/public/icon-512.png $out/share/icons/hicolor/512x512/apps/corkboard.png
            makeWrapper ${pkgs.lib.getExe pkgs.electron} $out/bin/corkboard-app \
              --add-flags $out/share/corkboard-app
          '';
          meta.mainProgram = "corkboard-app";
        };

        # fleetd and corkboard-fleet (fleet/fleetd), run by bun, laid out as
        # in the repo: both sign in to the Worker as the bridge does
        # (bridge/cloud.ts). No dependencies beyond bun's own.
        fleet = pkgs.stdenvNoCC.mkDerivation {
          pname = "corkboard-fleet";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./fleet/fleetd/fleet.ts ./fleet/fleetd/fleetd.ts ./fleet/fleetd/cli.ts ./fleet/fleetd/queue.ts ./fleet/fleetd/sessions.ts ./bridge/cloud.ts ./bridge/host.ts ./bridge/sessions.ts ./bridge/transcript.ts ./fleet/pepper/pepperd.ts ];
          };
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            share=$out/share/corkboard-fleet
            mkdir -p $share/fleet/fleetd $share/fleet/pepper $share/bridge
            cp fleet/fleetd/*.ts $share/fleet/fleetd/
            cp fleet/pepper/pepperd.ts $share/fleet/pepper/
            cp bridge/cloud.ts bridge/host.ts bridge/sessions.ts bridge/transcript.ts $share/bridge/
            makeWrapper ${pkgs.lib.getExe pkgs.bun} $out/bin/corkboard-fleetd \
              --add-flags $share/fleet/fleetd/fleetd.ts
            makeWrapper ${pkgs.lib.getExe pkgs.bun} $out/bin/corkboard-fleet \
              --add-flags $share/fleet/fleetd/cli.ts
            makeWrapper ${pkgs.lib.getExe pkgs.bun} $out/bin/corkboard-pepperd \
              --add-flags $share/fleet/pepper/pepperd.ts
          '';
          meta.mainProgram = "corkboard-fleet";
        };

        # Pepper's VM on the droplet (fleet/pepper/guest.nix), and the
        # droplet's half of it, which installs it there (fleet/pepper/pepper.nix).
        pepper-vm = self.nixosConfigurations.pepper-vm.config.system.build.vm;
        pepper = import ./fleet/pepper/pepper.nix {
          inherit pkgs fleet;
          inherit (pkgs) lib;
          plan = pepperPlan;
          vm = pepper-vm;
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
