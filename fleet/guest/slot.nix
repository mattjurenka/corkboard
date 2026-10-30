# The guest a slot boots: one spawned agent, one task (or one session), then off.
#
# A slot's addresses are fixed (its plan), what runs in it is not: `mkFleet`
# builds this module with each spawnable template's modules on top, as
# `nixosConfigurations."<template>@<slot>"`. Its hostName is the slot's, so
# the launcher's `run-<slot>-vm` is the same whatever it runs.
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
#   /mnt/outbox/events.jsonl a session's output, as stream-json
#   /mnt/outbox/projects/    a session's Claude Code logs, which fleetd
#                            follows while it runs (fleet/fleetd/sessions.ts)
#
# A template with a brain also mounts the brain's memory (its `shares`),
# writable where the brain says, and the same for every agent of it.
#
# Egress is the slot's allowlist, through the filtering proxy on its
# gateway; there is no resolver and no route, as for Pepper.
{ plan, template, ownerUid ? null }:
{ config, pkgs, lib, modulesPath, ... }:
let
  vm = plan;

  proxyUrl = "http://${vm.hostAddress}:${toString vm.proxyPort}";
  proxyEnv = {
    HTTP_PROXY = proxyUrl;
    HTTPS_PROXY = proxyUrl;
    http_proxy = proxyUrl;
    https_proxy = proxyUrl;
    NO_PROXY = "localhost,127.0.0.1";
    no_proxy = "localhost,127.0.0.1";
  };

  # Claude Code features whose hosts are not on any allowlist, off, so they
  # never start a request the proxy will refuse.
  claudeCodeEnv = {
    ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    CLAUDE_CODE_DISABLE_ARTIFACT = "1";
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    DISABLE_AUTOUPDATER = "1";
  };

  env = proxyEnv // claudeCodeEnv;

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
          | claude -p "''${mcp[@]}" \
              --input-format stream-json \
              --output-format stream-json \
              --verbose \
              --dangerously-skip-permissions \
              > "$out/events.jsonl" || status=$?
        # Its last answer, where a task's goes.
        jq -s '[.[] | select(.type == "result")] | last // {}' "$out/events.jsonl" > "$out/result.json" || true
      else
        claude -p "$(cat /mnt/share/task.md)" "''${mcp[@]}" \
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

    sharedDirectories = lib.mkForce ({
      share = { source = vm.shareDir; target = "/mnt/share"; writable = false; };
      outbox = { source = vm.outboxDir; target = "/mnt/outbox"; writable = true; };
    } // lib.mapAttrs (_: s: { inherit (s) source target writable; }) template.shares);

    diskImage = vm.diskImage;
    diskSize = lib.mkDefault (lib.max 8192 template.disk);
    memorySize = lib.mkDefault (lib.max 2048 template.memory);
    cores = lib.mkDefault (lib.max 2 template.cores);

    graphics = false;
    qemu.options = [
      "-serial mon:stdio"
      "-device virtio-serial-pci"
    ] ++ lib.concatMap
      (i: [
        "-chardev socket,id=${vm.consoleChardevId i},path=${vm.consoleSocketFor i},server=on,wait=off"
        "-device virtconsole,chardev=${vm.consoleChardevId i}"
      ])
      vm.consoleIndices;
    qemu.networkingOptions = lib.mkForce [
      "-netdev tap,id=net0,ifname=${vm.interface},script=no,downscript=no"
      "-device virtio-net-pci,netdev=net0,mac=${vm.mac}"
    ];
  };

  systemd.services = {
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
      description = "Interactive console on ${vm.consoleDevice 1}";
      wantedBy = [ "multi-user.target" ];
      after = [ "dev-${vm.consoleDevice 1}.device" ];
      bindsTo = [ "dev-${vm.consoleDevice 1}.device" ];
      serviceConfig = {
        ExecStart = "${pkgs.bashInteractive}/bin/bash -il";
        User = "claude";
        Group = config.users.users.claude.group;
        WorkingDirectory = "/home/claude";
        StandardInput = "tty";
        StandardOutput = "tty";
        StandardError = "tty";
        Environment = [ "TERM=xterm-256color" ];
        TTYPath = "/dev/${vm.consoleDevice 1}";
        TTYReset = true;
        TTYVHangup = true;
        Restart = "always";
        RestartSec = "1s";
      };
      unitConfig.StartLimitIntervalSec = 0;
    };
    "serial-getty@${vm.consoleDevice 1}".enable = false;
  };

  networking = {
    hostName = vm.name;
    usePredictableInterfaceNames = false;
    useDHCP = false;
    interfaces.eth0.ipv4.addresses = [{
      address = vm.guestAddress;
      prefixLength = vm.prefixLength;
    }];
    nameservers = lib.mkForce [ ];

    firewall.enable = true;
    firewall.extraCommands = ''
      iptables -I nixos-fw 1 -s ${vm.hostAddress} -j nixos-fw-accept
    '';
    firewall.extraStopCommands = ''
      iptables -D nixos-fw -s ${vm.hostAddress} -j nixos-fw-accept || true
    '';
  };

  services.openssh = {
    enable = true;
    listenAddresses = [{ addr = vm.guestAddress; port = 22; }];
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
  environment.etc."claude-code/managed-settings.json".text = builtins.toJSON { env = claudeCodeEnv; };
  # Where its brain's memory is, read as managed memory by every session.
  environment.etc."claude-code/CLAUDE.md" = lib.mkIf (template.shares != { }) {
    text = ''
      # Your brain's memory

      You work for the `${template.brain}` brain. Its memory is mounted here,
      shared with its other agents, so what you write there they will see:

      ${lib.concatStrings (lib.mapAttrsToList (n: s: "- `${s.target}`${lib.optionalString (!s.writable) " (read-only)"}: ${if s.description != "" then s.description else n}\n") template.shares)}
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
