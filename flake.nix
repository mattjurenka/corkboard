{
  description = "corkboard: Neovim in the browser, with agent panels beside it";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Neovim compiled to wasm (wasm/), on a nixpkgs of its own: emscripten
    # and the builds on it take hours, so they move only when this does.
    nixpkgs-wasm.url = "github:NixOS/nixpkgs/31ecbaca1bdefa45dffc409f0250bd8039ea0010";
    neovim-src = {
      url = "github:neovim/neovim/v0.12.6";
      flake = false;
    };
    # Claude Code for every machine: Pepper's VM, the droplet's workspace,
    # and (through nixosconfig's input, which follows this one) the laptop,
    # brain-vm and the fleet's slots. One lock, one version.
    claude-code = {
      url = "github:sadjow/claude-code-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixpkgs-wasm, neovim-src, claude-code, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
      # Pepper's VM on the droplet: its addresses, shared by the guest and
      # the droplet's half (fleet/pepper/).
      pepperPlan = import ./fleet/plan.nix { name = "pepper-vm"; interface = "pep0"; octet = 89; mac = "52:54:00:c1:a0:30"; };
      # Plugins the bridge puts on Neovim's runtimepath.
      # The commit built, for the status line, with no .git to ask.
      rev = self.shortRev or self.dirtyShortRev or "?";
      pluginPath = pkgs: pkgs.lib.concatStringsSep ":" [ pkgs.vimPlugins.snacks-nvim ];
      # The wasm build (wasm/), on x86_64-linux only, where it has been tried.
      wasmOn = system:
        if system == "x86_64-linux"
        then import ./wasm { pkgs = nixpkgs-wasm.legacyPackages.${system}; inherit neovim-src; nvimVersion = "0.12.6"; }
        else { packages = { }; checks = { }; shell = null; };
    in
    {
      # The agent VMs (fleet/, and .agent/plans/agent-fleet.md). A host that
      # runs them imports `fleetHost` and sets `my.agentVms`; `mkPlan` makes
      # the address plan each VM and the host share; `mkFleet` turns brains,
      # capabilities, environments and templates into checked guests.
      nixosModules.fleetHost = { pkgs, lib, ... }: {
        # Once, however many modules here import it.
        key = "corkboard/fleetHost";
        imports = [ ./fleet/host/host.nix ];
        my.agentVms.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.fleet;
      };
      # The whole fleet on a host: `services.corkboard.fleet` (fleet/host/corkboard.nix).
      nixosModules.fleet = {
        imports = [ self.nixosModules.fleetHost (import ./fleet/host/corkboard.nix { inherit (nixpkgs.lib) nixosSystem; }) ];
      };
      lib.fleet = {
        mkPlan = import ./fleet/plan.nix;
        mkPool = import ./fleet/pool.nix;
        # Claude Code hooks that give a guest's sessions its brain's memory.
        memoryHooks = import ./fleet/memory-hooks.nix;
        inherit (import ./fleet/lib.nix { inherit (nixpkgs) lib; }) mkFleet capabilities;
      };

      nixosConfigurations.pepper-vm = nixpkgs.lib.nixosSystem {
        modules = [
          (import ./fleet/pepper/guest.nix { plan = pepperPlan; memoryHooks = import ./fleet/memory-hooks.nix; })
          { nixpkgs.overlays = [ claude-code.overlays.default ]; }
        ];
      };

      checks = forAll (pkgs: {
        fleet = import ./fleet/tests.nix { inherit pkgs; inherit (pkgs) lib; };
      } // (wasmOn pkgs.stdenv.hostPlatform.system).checks);

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
        } // pkgs.lib.optionalAttrs ((wasmOn pkgs.stdenv.hostPlatform.system).shell != null) {
          wasm = (wasmOn pkgs.stdenv.hostPlatform.system).shell;
        });

      # The bridge, the web page and the Neovim plugin, laid out as in the repo
      # so server.ts finds ../web and ../nvim from its own path. Exposes
      # `corkboard-bridge`; the CORKBOARD_* variables still apply, and
      # plugins given in CORKBOARD_PLUGINS come before snacks.nvim.
      packages = forAll (pkgs: let nvimWasm = (wasmOn pkgs.stdenv.hostPlatform.system).packages.nvim-wasm or null; in
        pkgs.lib.filterAttrs (_: p: p != null) ((wasmOn pkgs.stdenv.hostPlatform.system).packages // rec {
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
            x86_64-linux = "sha256-CpRN9FzNzoVBpIZiuxuIjFFwbh3IZ6UXwumRhvrWIgw=";
          }.${pkgs.stdenv.hostPlatform.system} or pkgs.lib.fakeHash;
        };

        # The page as the bridge serves it (web/dist).
        web = pkgs.stdenvNoCC.mkDerivation {
          pname = "corkboard-web";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            # The page answers Neovim's cloud requests itself when it has no
            # machine, with the bridge's own code for it.
            fileset = pkgs.lib.fileset.unions [ ./package.json ./tsconfig.json ./web/index.html ./web/vite.config.ts ./web/src ./web/public ./bridge/cloud-session.ts ./bridge/kokoro-voices.ts ./bridge/kokoro-timing.ts ];
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

        # The avatar's voice on the GPU, if CORKBOARD_SPEECH_MODEL is set to it
        # (bridge/speech.ts): Kokoro's fp16 model as
        # bridge/kokoro-gpu.py patches it for ONNX Runtime's WebGPU EP.
        speech-model = pkgs.runCommand "corkboard-speech-model" {
          src = pkgs.fetchurl {
            url = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model_fp16.onnx";
            hash = "sha256-ukUnqHS0KyHjX0aMENMm/f88f8jKwfhenrbA38NcM0o=";
          };
          nativeBuildInputs = [ (pkgs.python3.withPackages (p: [ p.onnx p.numpy ])) ];
        } ''
          mkdir $out
          python3 -I ${./bridge/kokoro-gpu.py} $src $out/model.onnx
        '';

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
          # The avatar's voice (bridge/speech.ts): Kokoro on onnxruntime-node,
          # taken from webDeps, with onnxruntime's binaries for this system
          # only and linked to the libstdc++ here.
          speech = [ "kokoro-js" "phonemizer" "@huggingface/transformers" "onnxruntime-node" "onnxruntime-common" ];
          nativeBuildInputs = [ pkgs.makeWrapper pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.stdenv.cc.cc.lib ];
          installPhase = ''
            share=$out/share/corkboard
            mkdir -p $share/node_modules/@msgpack/msgpack
            cp -r bridge nvim mcp $share/
            echo ${rev} > $share/bridge/rev
            echo ${rev} > $share/nvim/rev
            mkdir -p $share/web && cp -r ${web} $share/web/dist
            tar -xzf $msgpack -C $share/node_modules/@msgpack/msgpack --strip-components=1
            for p in $speech; do
              mkdir -p $share/node_modules/$(dirname $p)
              cp -r ${webDeps}/$p $share/node_modules/$p
            done
            chmod -R u+w $share/node_modules
            arch=${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}
            ort=$share/node_modules/onnxruntime-node/bin/napi-v6
            find $ort -mindepth 2 -maxdepth 2 ! -path "$ort/linux/$arch" -exec rm -r {} +
            # transformers.js wants sharp, for images, to be there; speech never calls it.
            mkdir -p $share/node_modules/sharp
            echo '{"name":"sharp","main":"index.js"}' > $share/node_modules/sharp/package.json
            echo 'module.exports = () => { throw new Error("no sharp"); };' > $share/node_modules/sharp/index.js
            makeWrapper ${pkgs.lib.getExe pkgs.bun} $out/bin/corkboard-bridge \
              --add-flags $share/bridge/server.ts \
              --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.neovim pkgs.bun pkgs.ripgrep pkgs.fd ]} \
              --suffix CORKBOARD_PLUGINS : ${pluginPath pkgs} \
              --suffix LD_LIBRARY_PATH : ${pkgs.lib.makeLibraryPath [ pkgs.vulkan-loader ]} \
              ${pkgs.lib.optionalString (nvimWasm != null) "--set-default CORKBOARD_NVIM_WASM ${nvimWasm}/lib/nvim-wasm"}
            # A brain's vault into its memory in the Worker (bridge/memory-sync.ts).
            makeWrapper ${pkgs.lib.getExe pkgs.bun} $out/bin/corkboard-memory-sync \
              --add-flags $share/bridge/memory-sync.ts
          '';
          meta.mainProgram = "corkboard-bridge";
        };

        # The pinned Claude Code, for a profile outside NixOS (the droplet's
        # workspace). Unfree, hence its own nixpkgs.
        claude-code = (import nixpkgs {
          system = pkgs.stdenv.hostPlatform.system;
          config.allowUnfree = true;
          overlays = [ self.inputs.claude-code.overlays.default ];
        }).claude-code;

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
          chmod u+w $out
          echo ${rev} > $out/rev
        '';

        # The page the Worker serves at /edit/, with no machine behind it
        # (wasm/edit-page.ts), built into cloud/.edit by cloud/deploy.sh.
        # Its plugins are a bridge's: corkboard, then $CORKBOARD_PLUGINS when
        # built with --impure (the deploying machine's, for its theme), then
        # snacks.nvim unless those had it.
        edit-page = let
          given = builtins.getEnv "CORKBOARD_PLUGINS";
          theirs = map builtins.storePath (pkgs.lib.filter (p: p != "") (pkgs.lib.splitString ":" given));
          snacks = pkgs.lib.optional (!pkgs.lib.any (p: pkgs.lib.hasInfix "snacks" p) theirs) pkgs.vimPlugins.snacks-nvim;
          plugins = theirs ++ snacks;
        in if nvimWasm == null then null else pkgs.stdenvNoCC.mkDerivation {
          pname = "corkboard-edit-page";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./bridge/wasm.ts ./wasm/edit-page.ts ./nvim ];
          };
          nativeBuildInputs = [ pkgs.bun ];
          buildPhase = ''
            export HOME=$TMPDIR
            ln -s ${webDeps} node_modules
            bun wasm/edit-page.ts $out ${web} ${nvimWasm}/lib/nvim-wasm $PWD/nvim ${pkgs.lib.escapeShellArgs plugins}
          '';
          dontInstall = true;
        };
      }));
    };
}
