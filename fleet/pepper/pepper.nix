# Pepper, the personal assistant, on the droplet (the fleet's `cloud`
# environment, see .agent/plans/agent-fleet.md): one Claude Code session that
# is always running, in a VM of its own (./guest.nix). This is the droplet's
# half: the VM's network, its proxy and its launcher, and the
# `assistant` its resident has in the fleet's manifest (fleet-resident.json),
# by which fleetd (fleet/fleetd/assistant.ts) gives the session its corkboard
# token and pastes in the phone's chat, over ssh. The day plan's window
# (nvim/lua/corkboard/plan/claude.lua) logs in as the droplet's `pepper`
# user, whose only command is the ssh into the VM that attaches.
#
# The droplet is Ubuntu with Nix, not NixOS, so this is a profile
# (/nix/var/nix/profiles/corkboard-pepper) plus the files `install` links
# into /etc, as the cloud-0 slot's were put there.
{ pkgs, lib, plan, vm }:
let
  vmAddr = plan.guestAddress;
  ssh = home: opts: lib.concatStringsSep " " ([
    "${pkgs.openssh}/bin/ssh"
    # Not Ubuntu's ssh_config, whose options this ssh doesn't know.
    "-F /dev/null"
    "-i ${home}/.ssh/pepper-vm"
    "-o UserKnownHostsFile=${home}/.ssh/known_hosts"
    "-o StrictHostKeyChecking=accept-new"
    "-o BatchMode=yes"
    "-o ConnectTimeout=10"
  ] ++ opts ++ [ "claude@${vmAddr}" ]);
  fleetdSsh = ssh "/var/lib/corkboard" [ ];

  # From its tap, the proxy and nothing else; nothing forwarded either way
  # (as fleet/host/host.nix's rulesFor).
  nft = pkgs.writeText "pepper-vm.nft" ''
    table inet ${plan.name} {}
    delete table inet ${plan.name}

    table inet ${plan.name} {
      chain input {
        type filter hook input priority -10; policy accept;
        iifname "${plan.interface}" ip daddr ${plan.hostAddress} tcp dport ${toString plan.proxyPort} counter accept
        iifname "${plan.interface}" ct state established,related counter accept
        iifname "${plan.interface}" counter drop
      }

      chain forward {
        type filter hook forward priority -10; policy accept;
        oifname "${plan.interface}" counter drop
        iifname "${plan.interface}" counter drop
      }
    }
  '';

  # Any host on the internet, any port (Matt's call, 2026-11-12). What the
  # droplet itself and private networks serve is kept from it by the proxy
  # unit's IPAddressDeny, not here: a name can resolve to anything.
  proxyConf = pkgs.writeText "pepper-vm-proxy.conf" ''
    Port ${toString plan.proxyPort}
    Listen ${plan.hostAddress}
    Allow ${vmAddr}
    Timeout 600
    DisableViaHeader yes
    LogLevel Notice
  '';

  # The disk is kept: it holds the logins and the session's history.
  launch = pkgs.writeShellScript "pepper-vm-launch" ''
    set -eu
    mkdir -p ${plan.runDir}
    rm -f ${plan.runDir}/store.img ${plan.consoleSocket}
    exec ${vm}/bin/run-${plan.name}-vm
  '';

  # Asks the guest to power off, so Pepper's session ends as at 4am, then
  # waits for QEMU; systemd kills what's left once this returns.
  stop = pkgs.writeShellScript "pepper-vm-stop" ''
    ${fleetdSsh} sudo -n /run/current-system/sw/bin/systemctl poweroff || true
    for _ in $(seq 90); do
      kill -0 "$MAINPID" 2>/dev/null || exit 0
      sleep 1
    done
  '';

  # The pepper user's forced command, for the plan window.
  attach = pkgs.writeShellScript "pepper-attach" ''
    exec ${ssh "/home/pepper" [ "-tt" ]}
  '';

  units = {
    "pepper-vm-net.service" = ''
      [Unit]
      Description=Network isolation for Pepper's VM
      After=network-pre.target
      Before=network.target

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      # Owned by corkboard, so QEMU attaches without privilege. Rules first,
      # so the interface is never up unfiltered.
      ExecStart=/bin/sh -c 'ip link show ${plan.interface} >/dev/null 2>&1 || ip tuntap add dev ${plan.interface} mode tap user corkboard'
      ExecStart=/usr/sbin/nft -f ${nft}
      ExecStart=/usr/sbin/ip addr replace ${plan.hostAddress}/${toString plan.prefixLength} dev ${plan.interface}
      ExecStart=/usr/sbin/ip link set ${plan.interface} up
      ExecStop=-/usr/sbin/ip link set ${plan.interface} down
      ExecStop=-/usr/sbin/nft delete table inet ${plan.name}
      ExecStop=-/usr/sbin/ip link del ${plan.interface}

      [Install]
      WantedBy=multi-user.target
    '';
    "pepper-vm-proxy.service" = ''
      [Unit]
      Description=Pepper's VM's way out
      After=pepper-vm-net.service
      Requires=pepper-vm-net.service

      [Service]
      DynamicUser=yes
      ExecStart=${pkgs.tinyproxy}/bin/tinyproxy -d -c ${proxyConf}
      # Not the droplet's own services (the node, the workspace's bridge) nor
      # anything private: only the VM, resolved's stub, and the internet.
      IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7
      IPAddressAllow=${vmAddr}/32 ${plan.hostAddress}/32 127.0.0.53/32
      Restart=on-failure
      RestartSec=5s

      [Install]
      WantedBy=multi-user.target
    '';
    "pepper-vm.service" = ''
      [Unit]
      Description=Pepper's VM: one Claude Code session, always running
      After=pepper-vm-net.service pepper-vm-proxy.service
      Requires=pepper-vm-net.service pepper-vm-proxy.service

      [Service]
      Type=simple
      User=corkboard
      Group=corkboard
      SupplementaryGroups=kvm
      ExecStart=${launch}
      ExecStop=${stop}
      TimeoutStopSec=120
      WorkingDirectory=${plan.runDir}
      Environment=TMPDIR=${plan.runDir}
      Environment=USE_TMPDIR=1
      Restart=always
      RestartSec=10
      # 1024 MiB of guest and QEMU's own.
      MemoryMax=1400M

      [Install]
      WantedBy=multi-user.target
    '';
  };

  # Its resident's `assistant`, for /etc/corkboard/fleet.json's
  # residents.pepper-vm, which is written by hand on the droplet.
  resident = builtins.toJSON {
    ssh = fleetdSsh;
    tmuxSocket = "/run/pepper/tmux.sock";
    memoryTokenFile = "/var/lib/pepper/memory-token";
    sessionEnvFile = "/var/lib/pepper/session-env";
    chat = true;
  };

  # Run as root after `nix-env -p /nix/var/nix/profiles/corkboard-pepper
  # --set`: links the units into /etc and makes the VM's directory. The
  # Claude token goes into the VM by hand, once.
  install = pkgs.writeShellScript "pepper-install" ''
    set -eu
    profile=/nix/var/nix/profiles/corkboard-pepper/share/pepper
    install -d -m 0750 -o corkboard -g corkboard ${plan.stateDir} ${plan.runDir}
    for unit in $profile/systemd/*; do ln -sfn "$unit" /etc/systemd/system/; done
    systemctl daemon-reload
  '';
in
pkgs.runCommand "pepper-cloud" { } ''
  mkdir -p $out/bin $out/share/pepper/systemd
  ln -s ${install} $out/bin/pepper-install
  ln -s ${attach} $out/bin/pepper-attach
  cp ${pkgs.writeText "fleet-resident.json" resident} $out/share/pepper/fleet-resident.json
  ${lib.concatStrings (lib.mapAttrsToList (name: text: ''
    cp ${pkgs.writeText name text} $out/share/pepper/systemd/${name}
  '') units)}
''
