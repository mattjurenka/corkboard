# The guest a slot boots: one spawned agent, one task (or one session), then off.
#
# One guest per spawnable template, `nixosConfigurations."<template>@slot"`
# (`mkFleet`), and one per template and brain whose memory the host binds,
# `"<template>+<brain>@slot"`, that boots in any slot: the launcher says
# which, in its environment, and nothing of it is built in.
#
#   FLEET_DIR           the slot's state dir: share/, outbox/, disk.qcow2,
#                       console.sock
#   FLEET_TAP           its tap device, FLEET_MAC the MAC it has there
#   FLEET_MEMORY        MiB, and FLEET_CORES, if not the template's
#   QEMU_KERNEL_PARAMS  fleet.address=<guest>/<prefix> fleet.gateway=<host>,
#                       which fleet-net puts on eth0, as its default route
#                       and in /etc/hosts as fleet-gateway
#
# The task comes in and the result goes out the way they do for every agent
# VM here: a read-only share that fleetd fills before it starts the slot,
# and a writable outbox it collects once the slot stops.
#
#   /mnt/share/task.md       the prompt
#   /mnt/share/claude-token  the OAuth token of the account it runs as
#   /mnt/share/repo.bundle   optional: a git bundle of the repo to work in
#   /mnt/share/mcp.json      optional: corkboard's MCP server, with the spawn
#                            token for the agent's card (a spawn from the
#                            Worker's queue)
#   /mnt/share/brain-token   optional: a token for the brain it works for,
#                            which the memory hooks send, so each session
#                            starts with the brain's context and ends as one
#                            of its episodes (fleet/memory-hooks.nix)
#   /mnt/share/shell.json    optional: the tools the spawner brought, built
#                            here and run in: { "packages": [...] } from this
#                            guest's nixpkgs, or { "flake": ref }'s devShell
#                            ("." is the repo's). Only ever evaluated in the
#                            guest, so a shell can't reach the host's secrets
#   /mnt/share/session       for a session you talk to rather than a task:
#                            Claude Code keeps going, reading each message
#                            fleetd puts in /mnt/share/inbox/ (a file a stream-
#                            json line, named 0, 1, 2, ...; the first the task
#                            if there is one) until one is END, then finishes
#                            as a task does
#
#   /mnt/outbox/result.json  Claude Code's `--output-format json`
#   /mnt/outbox/work.bundle  the commits it made, if it was given a repo
#   /mnt/outbox/exit         its exit status
#   /mnt/outbox/shell.log    building its shell, if it brought one
#   /mnt/outbox/events.jsonl a session's output, as stream-json
#   /mnt/outbox/projects/    a session's Claude Code logs, which fleetd
#                            follows while it runs (fleet/fleetd/sessions.ts)
#
# A guest for a brain also mounts the brain's memory on this host (its
# binding's `shares`), writable where the binding says, and the same for
# every agent of it.
#
# Egress is the public internet, routed and NATed by the host, whose
# firewall keeps everything private (its LAN, the host itself) out of reach.
{ template, ownerUid ? null, brain ? null, shares ? { }, corkboardHost ? "portal.corkboard.fyi" }:
{ config, pkgs, lib, modulesPath, ... }:
let
  memory = toString config.virtualisation.memorySize;
  cores = toString config.virtualisation.cores;
  # Claude Code features a spawned agent has no use for: claude.ai's MCP
  # servers, artifacts, telemetry, and updating itself (Nix does that).
  claudeCodeEnv = {
    ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    CLAUDE_CODE_DISABLE_ARTIFACT = "1";
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    DISABLE_AUTOUPDATER = "1";
  };

  env = claudeCodeEnv;

  memoryHooks = import ../memory-hooks.nix {
    inherit pkgs lib;
    url = "https://${corkboardHost}";
    tokenFile = "/mnt/share/brain-token";
  };

  runTask = pkgs.writeShellApplication {
    name = "fleet-task";
    runtimeInputs = [ pkgs.git pkgs.coreutils pkgs.jq ];
    text = ''
      out=/mnt/outbox
      rm -rf "''${out:?}"/*

      CLAUDE_CODE_OAUTH_TOKEN=$(cat /mnt/share/claude-token)
      export CLAUDE_CODE_OAUTH_TOKEN

      work=$HOME/work
      rm -rf "$work"
      if [ -f /mnt/share/repo.bundle ]; then
        git clone --quiet /mnt/share/repo.bundle "$work"
        git -C "$work" checkout --quiet -B fleet-result
        base=$(git -C "$work" rev-parse HEAD)
      else
        mkdir -p "$work"
      fi
      cd "$work"

      mcp=()
      if [ -f /mnt/share/mcp.json ]; then mcp=(--mcp-config /mnt/share/mcp.json); fi

      # The spawner's tools, built first so a shell that doesn't build says
      # so rather than leaving Claude Code without them.
      run=()
      if [ -f /mnt/share/shell.json ]; then
        if flake=$(jq -er '.flake // empty' /mnt/share/shell.json); then
          run=(nix develop "$flake" --command)
        else
          mapfile -t pkgs < <(jq -r '.packages[] | "nixpkgs#" + .' /mnt/share/shell.json)
          run=(nix shell "''${pkgs[@]}" --command)
        fi
        if ! "''${run[@]}" true > "$out/shell.log" 2>&1; then
          jq -n --arg log "$(tail -c 4000 "$out/shell.log")" '{result: ("Its shell did not build:\n" + $log)}' > "$out/result.json"
          echo 1 > "$out/exit"
          exit 0
        fi
      fi

      status=0
      if [ -f /mnt/share/session ]; then
        # Its logs where fleetd can follow them.
        mkdir -p "$out/projects" "$HOME/.claude"
        rm -rf "$HOME/.claude/projects"
        ln -s "$out/projects" "$HOME/.claude/projects"
        # Each message as it arrives, by the next name: the share caches a
        # file's contents, never a name it hasn't seen. END closes Claude
        # Code's input, and it exits once the turn it's on is done.
        inbox() {
          local n=0 line
          while :; do
            if [ -e "/mnt/share/inbox/$n" ]; then
              line=$(cat "/mnt/share/inbox/$n")
              n=$((n + 1))
              if [ "$line" = END ]; then return; fi
              printf '%s\n' "$line"
            else
              sleep 0.5
            fi
          done
        }
        inbox \
          | "''${run[@]}" claude -p "''${mcp[@]}" \
              --input-format stream-json \
              --output-format stream-json \
              --verbose \
              --dangerously-skip-permissions \
              > "$out/events.jsonl" || status=$?
        # Its last answer, where a task's goes.
        jq -s '[.[] | select(.type == "result")] | last // {}' "$out/events.jsonl" > "$out/result.json" || true
      else
        "''${run[@]}" claude -p "$(cat /mnt/share/task.md)" "''${mcp[@]}" \
          --output-format json \
          --dangerously-skip-permissions \
          > "$out/result.json" || status=$?
      fi

      if [ -n "''${base:-}" ]; then
        # Whatever it left uncommitted, as one last commit, so nothing it
        # did is lost to the empty disk the next spawn gets.
        if [ -n "$(git status --porcelain)" ]; then
          git add -A
          git commit --quiet -m "fleet: uncommitted work at the end of the task"
        fi
        if [ "$(git rev-list --count "$base"..HEAD)" -gt 0 ]; then
          git bundle create --quiet "$out/work.bundle" "^$base" fleet-result
        fi
      fi

      echo "$status" > "$out/exit"
    '';
  };
in
{
  imports = [ "${modulesPath}/virtualisation/qemu-vm.nix" ];

  nixpkgs.hostPlatform = "x86_64-linux";
  nixpkgs.config.allowUnfree = true;

  virtualisation = {
    # The closure as an image the launcher builds on every start, with a
    # writable layer on the disk over it, so `nix build` works in the guest
    # and is gone with the disk when the task ends.
    useNixStoreImage = true;
    mountHostNixStore = false;
    writableStore = true;
    writableStoreUseTmpfs = false;

    # Shell words in the runner, so the slot's own paths at launch.
    sharedDirectories = lib.mkForce ({
      share = { source = "$FLEET_DIR/share"; target = "/mnt/share"; writable = false; };
      outbox = { source = "$FLEET_DIR/outbox"; target = "/mnt/outbox"; writable = true; };
    } // lib.mapAttrs (_: s: { inherit (s) source target writable; }) shares);

    diskImage = "$FLEET_DIR/disk.qcow2";
    diskSize = lib.mkDefault (lib.max 8192 template.disk);
    memorySize = lib.mkDefault (lib.max 2048 template.memory);
    cores = lib.mkDefault (lib.max 2 template.cores);

    graphics = false;
    # virtiofs's shared memory, sized at launch: upstream's is the built
    # memorySize, which a later -m can't change.
    qemu.enableSharedMemory = false;
    qemu.options = [
      "-m \${FLEET_MEMORY:-${memory}}"
      "-smp \${FLEET_CORES:-${cores}}"
      "-object memory-backend-memfd,id=mem0,size=\${FLEET_MEMORY:-${memory}}M,share=on"
      "-machine memory-backend=mem0"
      "-serial mon:stdio"
      "-device virtio-serial-pci"
      "-chardev socket,id=fleetconsole,path=$FLEET_DIR/console.sock,server=on,wait=off"
      "-device virtconsole,chardev=fleetconsole"
    ];
    qemu.networkingOptions = lib.mkForce [
      "-netdev tap,id=net0,ifname=$FLEET_TAP,script=no,downscript=no"
      "-device virtio-net-pci,netdev=net0,mac=$FLEET_MAC"
    ];
  };

  systemd.services = {
    # The slot's address and its gateway's, from the kernel's command line.
    fleet-net = {
      description = "The slot's address";
      wantedBy = [ "network-online.target" ];
      before = [ "network-online.target" "sshd.service" ];
      after = [ "sys-subsystem-net-devices-eth0.device" ];
      requires = [ "sys-subsystem-net-devices-eth0.device" ];
      path = [ pkgs.iproute2 pkgs.gnugrep pkgs.coreutils ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      script = ''
        address=$(grep -o 'fleet\.address=[^ ]*' /proc/cmdline | cut -d= -f2)
        gateway=$(grep -o 'fleet\.gateway=[^ ]*' /proc/cmdline | cut -d= -f2)
        if [ -z "$address" ] || [ -z "$gateway" ]; then
          echo "no fleet.address or fleet.gateway on the kernel's command line" >&2
          exit 1
        fi
        ip link set eth0 up
        ip addr replace "$address" dev eth0
        ip route replace default via "$gateway" dev eth0
        echo "$gateway fleet-gateway" >> /etc/hosts
      '';
    };

    fleet-task = {
      description = "The spawned agent's task";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "mnt-share.mount" "mnt-outbox.mount" ];
      wants = [ "network-online.target" ];
      # No task, no run and no power-off: a slot booted by hand stays up
      # to be looked at.
      unitConfig.ConditionPathExists = "/mnt/share/task.md";
      path = [ "/run/current-system/sw" ];
      serviceConfig = {
        Type = "oneshot";
        User = "claude";
        Group = config.users.users.claude.group;
        WorkingDirectory = "/home/claude";
        ExecStart = lib.getExe runTask;
        # Done, whatever happened: the unit on the host ends with QEMU,
        # which is how fleetd learns the task is over.
        ExecStopPost = "+${pkgs.systemd}/bin/systemctl poweroff --no-block";
      };
    };

    fleet-console = {
      description = "Interactive console on hvc0";
      wantedBy = [ "multi-user.target" ];
      after = [ "dev-hvc0.device" ];
      bindsTo = [ "dev-hvc0.device" ];
      serviceConfig = {
        ExecStart = "${pkgs.bashInteractive}/bin/bash -il";
        User = "claude";
        Group = config.users.users.claude.group;
        WorkingDirectory = "/home/claude";
        StandardInput = "tty";
        StandardOutput = "tty";
        StandardError = "tty";
        Environment = [ "TERM=xterm-256color" ];
        TTYPath = "/dev/hvc0";
        TTYReset = true;
        TTYVHangup = true;
        Restart = "always";
        RestartSec = "1s";
      };
      unitConfig.StartLimitIntervalSec = 0;
    };
    "serial-getty@hvc0".enable = false;
  };

  # Written to at boot (fleet-net), so a copy rather than the store's.
  environment.etc.hosts.mode = "0644";

  networking = {
    # The same in every slot; the runner is `run-agent-vm`.
    hostName = "agent";
    usePredictableInterfaceNames = false;
    useDHCP = false;
    nameservers = [ "1.1.1.1" "9.9.9.9" ];

    # Its one link is the host's tap, so ssh from there and nothing else.
    firewall.enable = true;
    firewall.interfaces.eth0.allowedTCPPorts = [ 22 ];
  };

  services.openssh = {
    enable = true;
    openFirewall = false;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  systemd.globalEnvironment = env;
  environment.sessionVariables = env;
  environment.etc."claude-code/managed-settings.json".text = builtins.toJSON {
    env = claudeCodeEnv;
    # A brain's spawn's memory, which does nothing without its token.
    hooks = memoryHooks.hooks;
  };
  # Where its brain's memory is, read as managed memory by every session.
  environment.etc."claude-code/CLAUDE.md" = lib.mkIf (shares != { }) {
    text = ''
      # Your brain's memory

      You work for the `${brain}` brain. Its memory is mounted here,
      shared with its other agents, so what you write there they will see:

      ${lib.concatStrings (lib.mapAttrsToList (n: s: "- `${s.target}`${lib.optionalString (!s.writable) " (read-only)"}: ${if s.description != "" then s.description else n}\n") shares)}
    '';
  };

  programs.git = {
    enable = true;
    config.user = { name = "corkboard fleet (${template.name})"; email = "fleet@corkboard.invalid"; };
  };

  users.mutableUsers = false;
  # `claude`, as in every agent VM here: `<slot>-ssh` logs in as it. Keys
  # come from the installing flake (mkFleet's `slotModules`).
  users.users.claude = {
    isNormalUser = true;
    # The host owner's uid, so its writes through virtiofs are allowed.
    uid = lib.mkIf (ownerUid != null) ownerUid;
    description = "Spawned agent";
    group = "users";
    password = "claude";
    extraGroups = [ "wheel" ];
  };

  environment.systemPackages = [ pkgs.curl pkgs.jq pkgs.git ];

  i18n.defaultLocale = "en_US.UTF-8";
  system.stateVersion = "26.11";
}
