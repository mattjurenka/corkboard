# Pepper, the personal assistant, on the droplet (the fleet's `cloud`
# environment, see .agent/plans/agent-fleet.md): one Claude Code session that
# is always running, in a VM of its own (./guest.nix). This is the droplet's
# half: the VM's network, its filtering proxy and its launcher, and
# corkboard-pepperd (pepperd.ts), which gives the session its corkboard token
# and pastes in the phone's chat, over ssh. The day plan's window
# (nvim/lua/corkboard/plan/claude.lua) logs in as the droplet's `pepper`
# user, whose only command is the ssh into the VM that attaches.
#
# The droplet is Ubuntu with Nix, not NixOS, so this is a profile
# (/nix/var/nix/profiles/corkboard-pepper) plus the files `install` links
# into /etc, as the cloud-0 slot's were put there.
{ pkgs, lib, fleet, plan, vm }:
let
  vmAddr = plan.guestAddress;
  # The pepper brain's egress (~/nixosconfig modules/features/fleet.nix):
  # Claude Code's own hosts, corkboard's Worker, and read-only Google.
  allowed = [
    "api.anthropic.com"
    "platform.claude.com"
    "claude.ai"
    "claude.com"
    "code.claude.com"
    "portal.corkboard.fyi"
    "oauth2.googleapis.com"
    "www.googleapis.com"
    "gmail.googleapis.com"
  ];

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
  pepperdSsh = ssh "/var/lib/corkboard" [ ];

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

  filter = pkgs.writeText "pepper-vm-allowed-domains.filter"
    (lib.concatMapStrings (d: "^${lib.escapeRegex d}$\n") allowed);

  proxyConf = pkgs.writeText "pepper-vm-proxy.conf" ''
    Port ${toString plan.proxyPort}
    Listen ${plan.hostAddress}
    Allow ${vmAddr}
    Timeout 600
    FilterDefaultDeny yes
    FilterExtended yes
    FilterURLs no
    Filter "${filter}"
    ConnectPort 443
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
    ${pepperdSsh} sudo -n /run/current-system/sw/bin/systemctl poweroff || true
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
      Description=Filtering proxy for Pepper's VM
      After=pepper-vm-net.service
      Requires=pepper-vm-net.service

      [Service]
      DynamicUser=yes
      ExecStart=${pkgs.tinyproxy}/bin/tinyproxy -d -c ${proxyConf}
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
    "corkboard-pepperd.service" = ''
      [Unit]
      Description=corkboard: Pepper's token, and the phone's chat into Pepper's session
      After=network-online.target pepper-vm.service
      Wants=network-online.target

      [Service]
      User=corkboard
      Group=corkboard
      Environment=CORKBOARD_CLOUD=https://portal.corkboard.fyi
      Environment=XDG_STATE_HOME=/var/lib/corkboard/state
      Environment="PEPPER_SSH=${pepperdSsh}"
      Environment="PEPPER_TMUX=${pepperdSsh} tmux -S /run/pepper/tmux.sock"
      ExecStart=${lib.getExe' fleet "corkboard-pepperd"}
      Restart=always
      RestartSec=10
      MemoryMax=256M
      NoNewPrivileges=yes
      ProtectSystem=strict
      ProtectHome=yes
      ReadWritePaths=/var/lib/corkboard
      PrivateTmp=yes

      [Install]
      WantedBy=multi-user.target
    '';
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
  ${lib.concatStrings (lib.mapAttrsToList (name: text: ''
    cp ${pkgs.writeText name text} $out/share/pepper/systemd/${name}
  '') units)}
''
