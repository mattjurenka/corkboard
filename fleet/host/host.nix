# Host-side plumbing for the isolated agent VMs: tap device, the firewall
# rules the guest cannot reach, the read-only drop box, and the launcher.
#
# Generalised from the single-VM version so that `claude-vm` (browser, open
# internet) and `brain-vm` (headless, four-domain allowlist) are two
# instances of one module rather than two copies of it. Everything that
# differs between them is an option below; everything that is the same --
# which is most of the boundary -- is written once.
#
# Moved here from ~/nixosconfig/modules/features/agent-vm on 2026-10-27, unchanged
# but for where the address plans come from: `my.agentVms.plans`, which the
# installing host sets (it was `self.lib.agentVm.instances` of that flake).
# See .agent/plans/agent-fleet.md.
{ pkgs, lib, config, ... }:
let
  cfg = config.my.agentVms;
  plans = cfg.plans;

  # Only the VMs this host actually asked for.
  active = lib.filterAttrs (name: _: plans ? ${name}) cfg.instances;

  allowlisted = lib.filterAttrs (_: inst: inst.egress == "allowlist") active;

  # Instances with a routed exception: a destination set they reach
  # directly, with no proxy in the path at all. This is a different kind of
  # widening from adding a domain to `allowedDomains` -- that one stays
  # inside the filter, this one steps outside it -- so it is deliberately a
  # separate option with its own reason string. See `routedEgress` below.
  routed = lib.filterAttrs (_: inst: inst.routedEgress != [ ]) active;

  # Re-indents an interpolated block so the generated .nft reads like
  # something a person wrote. Nix only applies the interpolation site's
  # leading whitespace to the first line.
  indentBy = pad: s:
    lib.concatStringsSep "\n${pad}" (lib.splitString "\n" (lib.removeSuffix "\n" s));

  # RFC1918, CGNAT, loopback and link-local, as a prefix test on the text
  # of a CIDR. Used by an assertion below rather than at rule-generation
  # time: a routed hole pointed at this LAN should fail to build, not
  # quietly generate a rule that is dropped later.
  privateDestination = d:
    builtins.match "^(10|127)\\..*" d != null
    || builtins.match "^169\\.254\\..*" d != null
    || builtins.match "^192\\.168\\..*" d != null
    || builtins.match "^172\\.(1[6-9]|2[0-9]|3[01])\\..*" d != null
    || builtins.match "^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\..*" d != null;

  # A reason string written into the generated .nft as comment lines, so
  # the ruleset carries the justification for every hole in it rather than
  # just the hole.
  commentBlock = text:
    lib.concatMapStrings (l: if l == "" then "#\n" else "# ${l}\n")
      (lib.splitString "\n" (lib.removeSuffix "\n" text));

  # An nftables anonymous set, or a bare value when there is only one, so
  # the generated rules read the way a person would write them.
  nftSet = xs:
    if lib.length xs == 1
    then lib.head xs
    else "{\n  ${lib.concatStringsSep ",\n  " xs}\n}";

  # Each VM's file carries only the explanation that applies to it.
  proxyHole = vm: inst:
    if inst.egress != "allowlist" then "" else ''
      # The deliberate hole in "the guest cannot talk to this machine" that
      # the whole design rests on: the filtering proxy it is required to go
      # through, since it has no route of its own. One port, one interface,
      # and the proxy only listens on ${vm.hostAddress}.
      iifname "${vm.interface}" tcp dport ${toString vm.proxyPort} counter accept
    '';

  # The second hole, and only for a guest that has a routed exception.
  dnsHole = vm: inst:
    if inst.routedEgress == [ ] then "" else ''

      # And a resolver, which only a guest with a routed exception needs: a
      # proxied request is a CONNECT naming the host, resolved by the proxy
      # on the guest's behalf, but a routed destination is one the guest
      # dials itself and therefore has to resolve itself. dnsmasq on
      # ${vm.hostAddress} answers, and only for the domains those
      # exceptions name -- it has no default upstream, so every other query
      # comes back REFUSED rather than being forwarded. Resolution stays an
      # allowlist, which is what keeps DNS from being a channel out with
      # arbitrary labels in it.
      iifname "${vm.interface}" udp dport 53 counter accept
      iifname "${vm.interface}" tcp dport 53 counter accept
    '';

  # One block per routed exception, each carrying its own reason. Scoped by
  # destination *and* port in a single rule, so neither half of a hole is
  # ever open without the other, and IPv4-only: the guest has no IPv6
  # address, and the catch-all drop below still covers that family.
  routedRules = vm: inst:
    lib.concatStringsSep "\n\n" (map
      (hole: lib.concatStringsSep "\n" (
        [ (lib.removeSuffix "\n" (commentBlock hole.reason)) ]
        ++ lib.optional (hole.tcpPorts != [ ])
          ''iifname "${vm.interface}" ip daddr ${nftSet hole.destinations} tcp dport ${nftSet hole.tcpPorts} counter accept''
        ++ lib.optional (hole.udpPorts != [ ])
          ''iifname "${vm.interface}" ip daddr ${nftSet hole.destinations} udp dport ${nftSet hole.udpPorts} counter accept''
      ))
      inst.routedEgress);

  egressRules = vm: inst:
    if inst.egress == "allowlist" then
      lib.optionalString (inst.routedEgress != [ ]) (routedRules vm inst + "\n\n")
      + ''
        # No other route off this machine. Everything else this guest
        # reaches, it reaches through the proxy on the host -- an
        # input-chain matter rather than a forwarding one, so there is
        # nothing else to accept here. A tool that ignores the proxy
        # environment and is not covered by an exception above fails
        # closed.
        iifname "${vm.interface}" counter drop
      ''
    else ''
      # Outbound: the public internet only. Everything private is
      # off-limits, which covers this laptop's LAN address, the router,
      # anything else on the same network, and link-local.
      iifname "${vm.interface}" ip daddr {
        10.0.0.0/8,
        100.64.0.0/10,
        127.0.0.0/8,
        169.254.0.0/16,
        172.16.0.0/12,
        192.168.0.0/16
      } counter drop
      iifname "${vm.interface}" ip6 daddr {
        ::1,
        fe80::/10,
        fc00::/7
      } counter drop

      iifname "${vm.interface}" counter accept
    '';

  # Everything the guest is not allowed to do is expressed here, on the
  # host, in its own table. A rogue guest can rewrite its own firewall all
  # it likes; it cannot reach these rules.
  #
  # The chain policies deliberately stay `accept` with targeted drops per
  # interface. A `policy drop` here would apply to every packet crossing
  # the hook, not just this VM's -- so an allowlisted VM would take down
  # the other VM's networking, and the host's, from a table that looks
  # VM-specific.
  rulesFor = name: inst:
    let vm = plans.${name}; in
    pkgs.writeText "${name}.nft" ''
      # Idempotent reload: declare, delete, then define for real.
      table inet ${name} {}
      delete table inet ${name}

      table inet ${name} {
        chain input {
          type filter hook input priority -10; policy accept;

          ${indentBy "    " (proxyHole vm inst)}
          ${indentBy "    " (dnsHole vm inst)}

          # Replies to connections *this machine* opened into the guest --
          # the mirror image of the forward chain's rule below, and the
          # thing that makes `curl http://${vm.guestAddress}:PORT` from the
          # host work at all. Without it the drop below eats the SYN-ACK of
          # every host-initiated connection, which presents as the guest
          # being unreachable rather than as a firewall rule, because the
          # packet that dies is the reply and not the request.
          #
          # It grants the guest nothing: `established` requires a packet to
          # have gone the other way first, and the only thing that can send
          # that packet is the host. A guest cannot reach any port here by
          # waiting, and the catch-all drop below still covers everything
          # it might send on its own initiative.
          iifname "${vm.interface}" ct state established,related counter accept

          # The guest has no other business talking to this machine at all.
          # It boots with a static address, so it needs neither DHCP nor
          # DNS from us. Dropping here also covers the gateway address
          # ${vm.hostAddress}, which is the only address of ours it can even
          # see. ARP is a separate family and still resolves, so routing
          # through us keeps working.
          iifname "${vm.interface}" counter drop
        }

        chain forward {
          type filter hook forward priority -10; policy accept;

          # Replies to connections the guest opened, and nothing else
          # inbound: no other machine can reach into the VM.
          oifname "${vm.interface}" ct state established,related counter accept
          oifname "${vm.interface}" counter drop

          ${indentBy "    " (egressRules vm inst)}
        }

        chain postrouting {
          type nat hook postrouting priority srcnat; policy accept;
          # NAT for a guest that has any routed path at all -- the whole
          # internet for an `open` VM, a named destination set for an
          # allowlisted one with exceptions. NAT on its own grants nothing:
          # the forward chain above still decides what may leave.
          ${lib.optionalString (inst.egress == "open" || inst.routedEgress != [ ]) ''
            ip saddr ${vm.subnet} oifname != "${vm.interface}" counter masquerade
          ''}
        }
      }
    '';

  # The VM has no window of its own: it renders to a SPICE socket, and
  # pixels only exist while a viewer is attached.
  viewerFor = name:
    let vm = plans.${name}; in
    pkgs.writeShellApplication {
      name = "${name}-view";
      runtimeInputs = [ pkgs.virt-viewer ];
      text = ''
        if [ ! -S ${vm.spiceSocket} ]; then
          echo "${name} does not appear to be running: no socket at ${vm.spiceSocket}" >&2
          exit 1
        fi
        exec remote-viewer "spice+unix://${vm.spiceSocket}" "$@"
      '';
    };

  # The headless equivalent of the viewer: an interactive shell on one of
  # the guest's virtio consoles. Needed for anything that has to be typed --
  # `claude` login, poking at the boundary -- because the first console is
  # wired to the journal and has no stdin.
  #
  # Takes an optional console number (`brain-vm-console 2`). With no
  # argument it claims the lowest free one, which is the common case: the
  # brain holds a long-running `claude` session on console 1 for hours, and
  # wanting a second shell should not mean remembering which number is
  # spare.
  #
  # "Free" is decided by a lock file, not by probing the socket. Connecting
  # to a busy chardev is the exact failure being avoided -- QEMU accepts one
  # client and leaves the rest in the accept backlog, indistinguishable from
  # a hang -- so it cannot also be the test for whether it is busy. flock is
  # held by this process for as long as it is attached and released by the
  # kernel when it exits, including on kill -9, so a crashed console does
  # not strand its slot.
  consoleFor = name:
    let
      vm = plans.${name};
      attach = i: ''
        if [ -z "$chosen" ] && [ -S ${vm.consoleSocketFor i} ]; then
          # Reassigning fd 9 closes the previous one, which releases any
          # lock it held -- so a failed attempt leaves nothing behind.
          exec 9>${vm.consoleLockFor i} || true
          if flock -n 9; then chosen=${toString i}; sock=${vm.consoleSocketFor i}; fi
        fi
      '';
    in
    pkgs.writeShellApplication {
      name = "${name}-console";
      runtimeInputs = [ pkgs.socat pkgs.systemd pkgs.util-linux ];
      text = ''
        # The sockets only appear once QEMU starts, which is after the
        # launcher has built the guest's Nix store image -- a couple of
        # minutes when the closure changed. Saying "does not appear to be
        # running" during that window is actively misleading, so
        # distinguish the two cases and wait out the boot.
        if [ ! -S ${vm.consoleSocket} ]; then
          if systemctl is-active --quiet ${name}.service; then
            printf '%s is starting (building its store image); waiting for the console' ${name} >&2
            for _ in $(seq 1 90); do
              [ -S ${vm.consoleSocket} ] && break
              printf '.' >&2
              sleep 2
            done
            printf '\n' >&2
          fi
        fi

        if [ ! -S ${vm.consoleSocket} ]; then
          if systemctl is-active --quiet ${name}.service; then
            echo "${name} is running but its console socket never appeared at ${vm.consoleSocket}." >&2
            echo "Check: journalctl -u ${name} -n 50" >&2
          else
            echo "${name} is not running. Start it with: systemctl start ${name}" >&2
          fi
          exit 1
        fi

        chosen=""
        sock=""

        if [ $# -gt 0 ]; then
          # The index-to-socket mapping is generated rather than rebuilt in
          # shell, so it cannot drift from `consoleSocketFor` in plan.nix --
          # which is the one place that knows console 1 keeps the
          # unsuffixed path.
          case "$1" in
            ${lib.concatMapStringsSep "\n    "
              (i: "${toString i}) sock=${vm.consoleSocketFor i}; lock=${vm.consoleLockFor i} ;;")
              vm.consoleIndices}
            *)
              echo "Usage: ${name}-console [${lib.concatMapStringsSep "|" toString vm.consoleIndices}]" >&2
              echo "This VM has ${toString vm.consoles} console(s)." >&2
              exit 2
              ;;
          esac
          chosen="$1"
          # An explicit request is honoured even when it looks busy. The
          # lock is advisory bookkeeping between wrappers, and overriding it
          # is a reasonable thing to want when a previous attach died oddly;
          # the warning is the whole safety measure. The lock is still taken
          # when free, so an explicit attach also reserves its slot.
          exec 9>"$lock" || true
          if ! flock -n 9; then
            echo "Warning: console $chosen already looks attached. Two clients on one" >&2
            echo "chardev share a single shell, so expect garbled output." >&2
          fi
        else
          ${indentBy "  " (lib.concatStringsSep "\n" (map attach vm.consoleIndices))}
          if [ -z "$chosen" ]; then
            echo "All ${toString vm.consoles} of ${name}'s consoles are in use." >&2
            echo "Detach one with Ctrl-O, or raise \`consoles\` for this instance in" >&2
            echo "modules/features/agent-vm/plan.nix and rebuild." >&2
            exit 1
          fi
        fi

        if [ ! -S "$sock" ]; then
          echo "Console $chosen has no socket at $sock -- is the VM running the" >&2
          echo "configuration that declares ${toString vm.consoles} consoles?" >&2
          exit 1
        fi

        echo "Attaching to ${name} console $chosen of ${toString vm.consoles}. Ctrl-O to detach." >&2
        # raw so the guest's shell sees a real terminal; escape=15 is Ctrl-O,
        # which detaches without signalling the guest.
        exec socat -,rawer,escape=15 "UNIX-CONNECT:$sock"
      '';
    };

  # The other way into a headless guest, and the better one once it has
  # booted: a real SSH session instead of a byte stream on a chardev.
  #
  # Why it sits next to `<name>-console` rather than replacing it. A
  # console exists before the guest's network does, before sshd does, and
  # on a disk with no authorized key yet -- it is how a guest that fails
  # to boot gets looked at, and how the first login on a fresh install
  # happens. SSH needs a guest that came up far enough to run a daemon. So
  # the console is for the machine and this is for the work, and the work
  # is most of it: consoles are a fixed small number, one client each, and
  # a guest running a long-lived agent session spends them. Sessions here
  # cost nothing and carry a pty, so the window size crosses the link
  # instead of every session starting at 80x24 with no SIGWINCH.
  #
  # No identity is passed. The guest authorizes a key whose private half
  # the owner's agent already holds, so the common case is passphraseless
  # and the fallback -- an agent that is not up yet -- is ssh prompting on
  # the terminal, which is the right thing to happen.
  #
  # Host keys are deliberately not verified. The guest regenerates them
  # whenever its disk is reinstalled, and this link has exactly two ends:
  # the forward chain above drops every non-reply addressed into the guest,
  # so there is nothing else that could be at the far end to impersonate.
  # Trust-on-first-use would add no assurance and one failure mode -- a
  # stale key in ~/.ssh/known_hosts presenting a security warning for an
  # event that was expected and benign. /dev/null on both known-hosts files
  # rather than a side file, so there is no state to go stale at all.
  sshFor = name:
    let vm = plans.${name}; in
    pkgs.writeShellApplication {
      name = "${name}-ssh";
      runtimeInputs = [ pkgs.openssh pkgs.systemd pkgs.coreutils ];
      text = ''
        if ! systemctl is-active --quiet ${name}.service; then
          echo "${name} is not running. Start it with: systemctl start ${name}" >&2
          exit 1
        fi

        opts=(
          -o StrictHostKeyChecking=no
          -o UserKnownHostsFile=/dev/null
          -o GlobalKnownHostsFile=/dev/null
          # Without this the two options above make ssh announce
          # "Permanently added ... to the list of known hosts" on every
          # single connection, to a file it was just told to throw away.
          -o LogLevel=ERROR
        )

        # The unit being active says QEMU is running, not that the guest
        # has booted -- on a cold start sshd is a minute or more behind it,
        # and `Connection refused` is a poor way to learn that. Probing the
        # port rather than authenticating, so a key that needs a passphrase
        # is asked for once, by the real connection, and not once per
        # attempt. `timeout` because a guest whose kernel is not up yet
        # does not refuse the connection, it ignores the ARP.
        probe() {
          timeout 2 bash -c "exec 3<>/dev/tcp/${vm.guestAddress}/22" 2>/dev/null
        }

        if ! probe; then
          printf 'waiting for sshd in %s' ${name} >&2
          ready=""
          for _ in $(seq 1 45); do
            printf '.' >&2
            sleep 2
            if probe; then ready=1; break; fi
          done
          printf '\n' >&2
          if [ -z "$ready" ]; then
            echo "Nothing is listening on ${vm.guestAddress}:22 after 90s." >&2
            echo "The console does not need the network, so look from there:" >&2
            echo "    ${name}-console" >&2
            echo "    systemctl status sshd" >&2
            exit 1
          fi
        fi

        # `-t` rather than nothing, because what gets run here is usually a
        # TUI: `claude` is the whole point of the command. With no tty on
        # this end ssh says so and carries on without one, so a pipeline
        # still works.
        if [ "$#" -eq 0 ]; then
          # sshd runs the login shell as a login shell, which is what picks
          # up the guest's /etc/profile -- its credentials and its working
          # directory. Nothing to add here.
          exec ssh "''${opts[@]}" -t "claude@${vm.guestAddress}"
        fi

        # A command gets the same treatment, which it would not by default:
        # sshd runs `bash -c` for a remote command, and that is not a login
        # shell, so `${name}-ssh claude -p ...` would otherwise run without
        # the tokens and in the wrong directory.
        #
        # Two layers of quoting because there are two shells between here
        # and the command: sshd's `bash -c`, which re-parses whatever ssh
        # joined its arguments into, and the `bash -l` that parses what
        # that one passes on.
        cmd=$(printf '%q ' "$@")
        exec ssh "''${opts[@]}" -t "claude@${vm.guestAddress}" \
          bash -lc "$(printf '%q' "$cmd")"
      '';
    };

  launcherFor = name: inst:
    let vm = plans.${name}; in
    pkgs.writeShellApplication {
      name = name;
      runtimeInputs = [ config.nix.package ] ++ lib.optional inst.ownsDisk pkgs.qemu-utils;
      text = ''
        # Reusing one directory keeps each launch from leaving a multi-GB
        # Nix store image behind in /tmp.
        export TMPDIR=${vm.runDir}
        export USE_TMPDIR=1
        mkdir -p "$TMPDIR"

        # Stale sockets from a VM that was killed rather than shut down.
        # QEMU binds these with server=on and will not start if a previous
        # process left the files behind.
        rm -f ${vm.spiceSocket} ${vm.consoleSocket}
      '' + (if inst.ownsDisk then ''

        # This guest boots its own disk, so the disk is a precondition
        # rather than something a launch creates. qemu-vm.nix *would*
        # create one if it were missing -- an empty ext4 filesystem with no
        # partition table, no ESP and no bootloader -- and with
        # `directBoot` off QEMU would hand that to OVMF, which would find
        # nothing bootable and sit in the firmware's boot-manager shell
        # with `Restart=on-failure` cycling it every ten seconds. The
        # journal for that failure says nothing about a missing disk, so
        # the check is here instead and it is loud.
        if [ ! -f ${vm.diskImage} ]; then
          echo "${name}: no disk at ${vm.diskImage}." >&2
          echo "" >&2
          echo "This VM owns its filesystem -- a full NixOS install with its" >&2
          echo "own bootloader -- so the disk is installed once, deliberately," >&2
          echo "rather than created by a launch. Install one with:" >&2
          echo "" >&2
          echo "    ${name}-install-disk" >&2
          echo "" >&2
          echo "or, if you are moving state off an older image, see" >&2
          echo "    ${name}-migrate-disk --help" >&2
          exit 1
        fi

        # And the sharper edge, which is a disk that exists but is the
        # wrong kind. The image this VM ran on before 2026-10-14 is a bare
        # ext4 filesystem: no partition table, no ESP, no bootloader,
        # because the host used to hand QEMU a kernel directly. It is still
        # sitting at exactly the path the launcher looks at, so a host
        # `nixos-rebuild switch` followed by a restart -- or just a laptop
        # reboot -- would start QEMU against it with nothing to boot. OVMF
        # would drop into its boot-manager shell, `Restart=on-failure`
        # would cycle it every ten seconds, and the console a person
        # attached to would be silent, which is the single most expensive
        # failure mode this VM has.
        #
        # The marker is written by ${name}-install-disk, so its absence
        # means the disk at that path was not installed by it. A file
        # rather than inspecting the image because inspecting it means
        # attaching it to an nbd device, and doing that in a launcher --
        # against an image QEMU may be about to open -- is a worse idea
        # than a stat.
        if [ ! -e ${vm.stateDir}/.disk-owned ]; then
          echo "${name}: the disk at ${vm.diskImage} was not installed by" >&2
          echo "${name}-install-disk, so it is almost certainly the old" >&2
          echo "bare-filesystem image -- which has no bootloader and would" >&2
          echo "give you a silent ten-second restart loop rather than a VM." >&2
          echo "" >&2
          echo "Move its state onto a disk of its own with:" >&2
          echo "" >&2
          echo "    sudo ${name}-migrate-disk stage" >&2
          echo "    sudo ${name}-migrate-disk install" >&2
          echo "    sudo ${name}-migrate-disk restore" >&2
          echo "" >&2
          echo "If this disk really is a self-booting one -- restored from a" >&2
          echo "backup, say -- then say so and start again:" >&2
          echo "    touch ${vm.stateDir}/.disk-owned" >&2
          exit 1
        fi

        # The firmware's writable variable store. Upstream defaults this to
        # a file named after the guest in the *current directory*, which
        # for the systemd unit is ${vm.runDir} -- so it would work, but by
        # accident, and it would move if anyone ran the launcher by hand
        # from a terminal. Named explicitly so the boot entries the guest
        # writes are the same ones it finds next time, wherever it is
        # started from.
        export NIX_EFI_VARS=${vm.stateDir}/efi-vars.fd

        # Left behind by the store-image era, up to 7.8 GB of it, and
        # nothing reads it any more. Removed on sight rather than in a
        # migration step so that it goes whether or not anyone ran one.
        rm -f "$TMPDIR"/store.img
      '' else ''

        # And the stale store image, for the same reason and with much
        # worse consequences. mkfs.erofs streams the closure into a data
        # region at the 1 TiB mark and writes the superblock and metadata
        # at the front only once it finishes, so a run that is killed
        # part-way leaves a 2 TiB sparse file holding the data but no
        # filesystem. Nothing downstream notices: the next launch's
        # mkfs.erofs is happy to overwrite it, but if that one is killed
        # too the file persists, QEMU attaches it without complaint, and
        # the guest's initrd waits 90s for /dev/disk/by-label/nix-store,
        # gives up, and drops into emergency mode -- where a locked root
        # account means no getty either, so the console a person attaches
        # to is silent. Deleting it up front costs nothing, because the
        # run script rebuilds it unconditionally anyway, and makes that
        # failure unreachable.
        rm -f "$TMPDIR"/store.img
      '') + ''

        runner=$(nix build --no-link --print-out-paths \
          "${cfg.flake}#nixosConfigurations.${name}.config.system.build.vm")
        exec "$runner"/bin/run-${name}-vm "$@"
      '';
    };

  # A slot's launcher. The guest is whichever template fleetd claimed the
  # slot for, written into ${stateDir}/template before it starts the unit,
  # and is built as `nixosConfigurations."<template>@<slot>"`: the template's
  # modules on this slot's addresses. Every spawn starts from an empty disk,
  # so nothing one task leaves behind is there for the next.
  slotLauncherFor = name:
    let vm = plans.${name}; in
    pkgs.writeShellApplication {
      name = "${name}-run";
      runtimeInputs = [ config.nix.package pkgs.coreutils ];
      text = ''
        template=$(cat ${vm.stateDir}/template 2>/dev/null || true)
        known=(${lib.escapeShellArgs spawnable})
        ok=""
        for t in "''${known[@]}"; do
          if [ "$t" = "$template" ]; then ok=1; fi
        done
        if [ -z "$ok" ]; then
          echo "${name}: no spawnable template in ${vm.stateDir}/template (got '$template')." >&2
          echo "Spawnable here: ${lib.concatStringsSep ", " spawnable}" >&2
          exit 1
        fi

        export TMPDIR=${vm.runDir}
        export USE_TMPDIR=1
        mkdir -p "$TMPDIR"
        rm -f ${vm.spiceSocket} ${lib.concatStringsSep " " vm.consoleSockets} "$TMPDIR"/store.img ${vm.diskImage}

        runner=$(nix build --no-link --print-out-paths \
          "${cfg.flake}#nixosConfigurations.\"$template@${name}\".config.system.build.vm")
        exec "$runner"/bin/run-${name}-vm "$@"
      '';
    };

  spawnable = lib.attrNames (lib.filterAttrs (_: t: t.spawnable or false) cfg.templates);

  # What fleetd and corkboard-fleet read: the slots, the VMs that are always
  # there (they count against the budget while they run), the templates a
  # slot can take, and the budget itself.
  manifest = {
    inherit (cfg) flake owner memoryBudget;
    slots = lib.mapAttrs
      (name: inst:
        let vm = plans.${name}; in {
          inherit (vm) guestAddress stateDir shareDir outboxDir;
          unit = "${name}.service";
        })
      (lib.filterAttrs (_: inst: inst.slot) active);
    residents = lib.mapAttrs
      (name: inst: {
        unit = "${name}.service";
        memory = inst.memoryMax;
      })
      (lib.filterAttrs (_: inst: inst.headless && !inst.slot) active);
    templates = lib.mapAttrs
      (_: t: { inherit (t) memory cores needsApproval brain capNames; })
      (lib.filterAttrs (_: t: t.spawnable or false) cfg.templates);
  };

  # Installs the disk a `ownsDisk` guest boots: one `make-disk-image`
  # build, one `qemu-img convert`, one resize, and the VM has a filesystem
  # of its own that nothing on the host owns a layer of.
  #
  # The convert is what makes it standalone, and it is the whole reason
  # this is a script rather than `virtualisation.useBootLoader = true`.
  # Upstream's bootloader mode creates the runtime image as a qcow2 with
  # the store's copy as its *backing file*, which means the guest's disk
  # depends forever on a store path the host is free to garbage-collect --
  # and the failure when it does is a VM that no longer boots and a `nix
  # store gc` nobody connects to it. `qemu-img convert` copies the clusters
  # out instead, so what lands in the state directory is a complete disk
  # that survives `nix-collect-garbage -d`.
  installerFor = name:
    let vm = plans.${name}; in
    pkgs.writeShellApplication {
      name = "${name}-install-disk";
      runtimeInputs = [
        config.nix.package
        pkgs.qemu-utils
        pkgs.coreutils
        pkgs.gnused
        # `systemctl is-active`, to refuse to write a disk out from under
        # a running QEMU -- it holds a write lock, so this would fail
        # anyway, but later and less clearly.
        pkgs.systemd
      ];
      text = ''
        disk=${vm.diskImage}

        if [ "''${1:-}" = "--help" ]; then
          echo "usage: ${name}-install-disk [--force]"
          echo
          echo "Builds a complete NixOS disk image for ${name} -- GPT, ESP,"
          echo "systemd-boot, and the whole store on an ext4 root -- and"
          echo "writes it to $disk as a standalone qcow2."
          echo
          echo "Refuses to overwrite an existing disk without --force."
          echo "Run as ${cfg.owner}, not root: the file has to belong to the"
          echo "user QEMU runs as."
          exit 0
        fi

        if [ "$(id -un)" != "${cfg.owner}" ]; then
          echo "Run this as ${cfg.owner} -- QEMU runs as that user and has to" >&2
          echo "be able to write the disk. Currently $(id -un)." >&2
          exit 1
        fi

        if [ -e "$disk" ] && [ "''${1:-}" != "--force" ]; then
          echo "$disk already exists." >&2
          echo "" >&2
          echo "Installing over it would discard everything the guest has" >&2
          echo "put on it, which for ${name} includes its credentials in" >&2
          echo "/var/lib and whatever it has not pushed. Move the state" >&2
          echo "across with '${name}-migrate-disk' instead, or pass" >&2
          echo "--force if you genuinely want a blank machine." >&2
          exit 1
        fi

        if systemctl is-active --quiet ${name}.service; then
          echo "${name} is running. Stop it first:" >&2
          echo "    sudo systemctl stop ${name}" >&2
          exit 1
        fi

        echo "Building the disk image. This is a full NixOS install inside a"
        echo "build VM -- several minutes, and it compiles nothing that the"
        echo "binary cache already has."
        image=$(nix build --no-link --print-out-paths \
          "${cfg.flake}#nixosConfigurations.${name}.config.system.build.installDisk")

        # --apply toString, not bare --raw: `diskSize` is an integer, and
        # --raw refuses to coerce one ("cannot coerce an integer to a
        # string: 81920"). --json would also work and would hand back the
        # same digits, but this says what it means.
        size=$(nix eval --raw --apply toString \
          "${cfg.flake}#nixosConfigurations.${name}.config.virtualisation.diskSize")

        # Belt and braces on a value the arithmetic below depends on: an
        # empty or non-numeric $size would turn `qemu-img resize` into a
        # confusing qemu error and `$(( ))` into a silent zero.
        case "$size" in
          "" | *[!0-9]*)
            echo "Could not read virtualisation.diskSize as a number" >&2
            echo "(got: '$size'). Refusing to size the disk from it." >&2
            exit 1
            ;;
        esac

        echo "Copying it out of the store as a standalone qcow2."
        # -p for progress, because this is gigabytes and silence here looks
        # like a hang. No -b: the output must not reference the store.
        qemu-img convert -p -O qcow2 "$image"/nixos.qcow2 "$disk.new"
        # Virtual size only -- qcow2 is sparse, so this costs nothing until
        # the guest writes. The guest grows the partition and the
        # filesystem into it on its first boot: see `boot.growPartition`
        # and `fileSystems."/".autoResize` in the guest's configuration.
        #
        # Guarded, because qemu-img refuses to shrink without --shrink and
        # that is the right refusal: if the closure has outgrown
        # `virtualisation.diskSize` then the number is wrong, and silently
        # truncating a filesystem is not the way to find that out.
        have=$(qemu-img info --output=json "$disk.new" \
          | sed -n 's/.*"virtual-size": \([0-9]*\).*/\1/p' | head -1)
        want=$(( size * 1024 * 1024 ))
        if [ "$have" -lt "$want" ]; then
          echo "Growing it to ''${size} MiB."
          qemu-img resize "$disk.new" "''${size}M"
        else
          echo "Image is already $(( have / 1024 / 1024 )) MiB, which is at or"
          echo "over the ''${size} MiB in virtualisation.diskSize. Leaving it."
        fi

        mv -f "$disk.new" "$disk"
        chmod 0600 "$disk"

        # The flake the guest will seed /etc/nixos from on first boot,
        # handed in through the read-only drop box.
        #
        # Through the drop box rather than baked into the image, because
        # baking it in means interpolating the flake source into the
        # guest's closure -- and then every edit to any file in the
        # repository, host files included, rebuilds the guest's system and
        # this 8 GB image with it. A copy into a share costs nothing and
        # the guest's closure stops depending on the repository's contents
        # entirely. See `seed-etc-nixos` in the guest's configuration.
        #
        # Refreshed on every install, and safe to re-run by hand at any
        # time: the guest only reads it once, when /etc/nixos is empty, so
        # updating it is deliberate rather than creeping.
        #
        # Staged under a .new name and moved into place, so a drop box the
        # guest is reading from never contains a half-copied tree.
        echo "Handing the flake in through the drop box for /etc/nixos."
        rm -rf ${vm.shareDir}/nixosconfig.new
        cp -r ${cfg.flake} ${vm.shareDir}/nixosconfig.new
        rm -rf ${vm.shareDir}/nixosconfig
        mv ${vm.shareDir}/nixosconfig.new ${vm.shareDir}/nixosconfig

        # What tells the launcher this disk is one it may boot. The image
        # that lived at this path before 2026-10-14 had no bootloader, and
        # QEMU will happily attach it and find nothing -- so the launcher
        # requires this marker rather than trusting the path. Written last,
        # after everything else, so an interrupted install leaves a disk
        # the launcher still refuses.
        touch ${vm.stateDir}/.disk-owned

        echo ""
        echo "Installed $disk"
        qemu-img info "$disk" | sed 's/^/  /'
        echo ""
        echo "Start it with: sudo systemctl start ${name}"
        echo "Then get a shell with: ${name}-console"
        echo ""
        echo "This disk is blank apart from the system: no credentials, no"
        echo "Claude Code login, no checkouts. If you meant to carry those"
        echo "over from an older disk, that is ${name}-migrate-disk."
        echo "get in with: ${name}-console"
      '';
    };

  # The one-time move from a host-overlaid filesystem to a guest-owned one.
  #
  # Three steps rather than one command, because the middle one takes
  # minutes and the first one is the only one that can lose anything. Each
  # is separately re-runnable, and `stage` is the one that matters: the
  # guest's credentials live nowhere else. /var/lib/second-brain holds the
  # Graph client id, two GitHub PATs and a Google OAuth client with a
  # refresh token next to it, and /home/claude/.claude holds the Claude
  # Code login, which is per-machine and would otherwise have to be done
  # again on a console with no browser.
  #
  # No nbd and no libguestfs: the old image is read with `debugfs` and the
  # new one is written through a loop mount. Both are plain files on the
  # host. See the long note above `raw_copy_of` for the two nbd attempts
  # that came first and why neither worked.
  migratorFor = name:
    let vm = plans.${name}; in
    pkgs.writeShellApplication {
      name = "${name}-migrate-disk";
      runtimeInputs = [
        pkgs.qemu-utils
        pkgs.util-linux
        pkgs.kmod
        pkgs.rsync
        pkgs.coreutils
        # debugfs, to read the old disk without mounting it, and fsck.ext4
        # to replay its journal onto the copy first.
        pkgs.e2fsprogs
        # Reading the new disk's partition table, so the loop offset is
        # looked up rather than hardcoded.
        pkgs.jq
        # systemctl, to stop and start the VM around the disk being
        # replaced.
        pkgs.systemd
      ];
      text = ''
        disk=${vm.diskImage}
        old="$disk.pre-ownfs"
        stage=${vm.stateDir}/migrate-stage
        mnt=${vm.stateDir}/migrate-mnt
        # The scratch raw image both steps work through: the old disk's
        # journal is replayed onto a copy here rather than onto the
        # original, and the new disk makes a round trip through here to be
        # loop-mounted. Sparse, deleted at the end of each step, and never
        # the only copy of anything.
        raw=${vm.stateDir}/migrate-raw.img

        # What has to survive. Everything else on the old disk is either
        # regenerable (the store, the nix database, logs, the machine id)
        # or was never the guest's to keep.
        #
        #   /var/lib/second-brain  credentials, the RAG index, and the git
        #                          checkouts in work/ -- which hold any
        #                          commit the brain has not pushed.
        #   /home/claude           ~/.claude: the Claude Code login for
        #                          this machine, its session state and its
        #                          shell history.
        paths="var/lib/second-brain home/claude"

        usage() {
          cat <<EOF
        usage: sudo ${name}-migrate-disk <stage|install|restore|all>

        Moves ${name} from the old host-overlaid filesystem onto a disk of
        its own. Run the steps in order, or 'all' to run all three.

          stage    Stop the VM, copy its disk to a raw image, replay the
                   journal on that copy, and extract the guest's state out
                   of it with debugfs into $stage. The original disk is
                   only ever read.
                   This is the step that cannot be redone once 'install'
                   has run, so it refuses to proceed if the old disk has
                   already been moved aside.

          install  Move the old disk to $old and install a fresh one with
                   ${name}-install-disk. The old image is kept, not deleted
                   -- it is ~21 GB, and deleting it is a separate decision
                   for after the new one has proved itself.

          restore  Mount the new disk and copy $stage back into it, then
                   start the VM.

        Must run as root, so that the extracted tree keeps the guest's own
        uids and modes, and so the new disk can be mounted.
        EOF
        }

        case "''${1:-}" in
          stage|install|restore|all) step=$1 ;;
          -h|--help|"") usage; exit 0 ;;
          *) usage >&2; exit 1 ;;
        esac

        if [ "$(id -u)" != 0 ]; then
          echo "Must run as root: reading the old disk has to preserve the" >&2
          echo "guest's uids, and writing the new one needs a mount." >&2
          exit 1
        fi

        # Everything below reads and writes disk images as plain files.
        # There is deliberately no nbd left in here, and the reason is
        # worth recording, because it misled twice.
        #
        # The first version attached the old image with `qemu-nbd
        # --read-only` and mounted it `-o ro`. That cannot work: the guest
        # is killed by `systemctl stop` rather than shut down, so its ext4
        # carries `needs_recovery` and `orphan_present`, and the kernel
        # refuses a read-only mount of a filesystem that needs journal
        # replay -- mounting it ro is exactly what stops it replaying. The
        # error is "cannot mount /dev/nbd0 read-only", which says nothing
        # about journals.
        #
        # The second attached a scratch qcow2 overlay so the replay could
        # land somewhere harmless, and got "can't read superblock on
        # /dev/nbd0". That was not a filesystem problem at all: reading the
        # same overlay with `qemu-img dd` returned a perfectly good
        # superblock, so qemu's view of it was fine and the kernel's nbd
        # device was not -- a reconnect to a device that had just been
        # disconnected, serving stale cache.
        #
        # So the old disk is read with `debugfs`, which is userspace
        # reading a file: no block device, no mount, no kernel module and
        # nothing to go stale. `fsck` replays the journal onto a *copy*
        # first, so the view is consistent and the original is never
        # written. The new disk is written through a loop mount, which is a
        # freshly created clean filesystem with none of the above surface.

        # Make a raw copy of $1 at $raw with its journal replayed.
        raw_copy_of() {
          local src=$1
          echo "==> Copying $src to a raw image we can read safely."
          echo "    A copy, because replaying a journal means writing, and"
          echo "    the only copy of the brain's credentials is not the"
          echo "    thing to write to in the middle of a migration."
          rm -f "$raw"
          qemu-img convert -p -O raw "$src" "$raw"

          echo "==> Replaying the journal on the copy."
          # -f because the superblock still says "clean" while
          # needs_recovery is set, and without it fsck decides there is
          # nothing to do. -p to fix what is safely fixable unattended.
          # Exit 1 means "fixed something", which is the expected result
          # here; 2 and above mean it wants a human.
          local rc=0
          fsck.ext4 -fp "$raw" || rc=$?
          if [ "$rc" -gt 1 ]; then
            echo "fsck.ext4 exited $rc on the copy, so it could not repair" >&2
            echo "it unattended. The original at $src is untouched; nothing" >&2
            echo "has been staged and nothing has been moved." >&2
            exit 1
          fi
        }

        do_stage() {
          if [ -e "$old" ]; then
            echo "$old already exists, so 'install' has already run and the" >&2
            echo "disk at $disk is the new one. Staging from it now would" >&2
            echo "copy the new machine over the saved state." >&2
            echo "If you need to redo this, stage from $old by hand." >&2
            exit 1
          fi
          if [ ! -f "$disk" ]; then
            echo "No disk at $disk -- nothing to stage." >&2
            exit 1
          fi

          echo "==> Stopping ${name}."
          systemctl stop ${name}.service || true

          raw_copy_of "$disk"

          mkdir -p "$stage"
          for p in $paths; do
            if ! debugfs -R "stat /$p" "$raw" >/dev/null 2>&1; then
              echo "    /$p: not on the old disk, skipping."
              continue
            fi
            echo "==> Extracting /$p"
            mkdir -p "$stage/$(dirname "$p")"
            # :? on both halves so this can never degrade into `rm -rf /`
            # if either variable is unset -- shellcheck SC2115, and it is
            # right to insist: this runs as root, two lines after a `mkdir
            # -p`, in a script whose whole job is moving the only copy of
            # the brain's credentials.
            rm -rf "''${stage:?}/''${p:?}"
            # rdump writes <dest>/<basename of src>, so the destination is
            # the parent directory. Run as root, so the uids, gids and
            # modes on the extracted tree are the guest's own rather than
            # whoever ran this.
            debugfs -R "rdump /$p $stage/$(dirname "$p")" "$raw" 2>/dev/null
            if [ ! -d "$stage/$p" ]; then
              echo "Extracting /$p produced nothing. Stopping rather than" >&2
              echo "going on to move the old disk aside." >&2
              exit 1
            fi
          done

          rm -f "$raw"

          echo ""
          echo "Staged $(du -sh "$stage" | cut -f1) into $stage"
          du -sh "$stage"/* 2>/dev/null | sed 's/^/  /' || true
          echo ""
          echo "Check that every path you expected is listed above with a"
          echo "real size before going on -- the credentials and anything"
          echo "unpushed live only on the old disk until 'restore' has run."
          echo ""
          echo "Next: sudo ${name}-migrate-disk install"
        }
        do_install() {
          if [ ! -d "$stage" ]; then
            echo "Nothing staged at $stage. Run 'stage' first -- the guest's" >&2
            echo "credentials and unpushed work live only on the old disk." >&2
            exit 1
          fi

          systemctl stop ${name}.service || true

          if [ -f "$disk" ] && [ ! -e "$old" ]; then
            echo "==> Moving the old disk to $old"
            mv "$disk" "$old"
          fi

          # The launcher's "this disk is bootable" marker. Cleared here and
          # written again by the installer, so that it means what it says
          # even if the install below fails half way: no marker, no start.
          rm -f ${vm.stateDir}/.disk-owned

          echo "==> Installing a fresh disk."
          # As the owner, not root: QEMU runs as ${cfg.owner} and the file
          # has to belong to it.
          runuser -u ${cfg.owner} -- ${lib.getExe (installerFor name)}

          echo ""
          echo "Next: sudo ${name}-migrate-disk restore"
        }

        do_restore() {
          if [ ! -f "$disk" ]; then
            echo "No disk at $disk. Run 'install' first." >&2
            exit 1
          fi
          if [ ! -d "$stage" ]; then
            echo "Nothing staged at $stage." >&2
            exit 1
          fi
          if systemctl is-active --quiet ${name}.service; then
            echo "${name} is running; stopping it before touching its disk." >&2
            systemctl stop ${name}.service
          fi

          echo "==> Converting the new disk to raw so it can be grown and mounted."
          # qcow2 cannot be loop-mounted, and nbd is not coming back, so
          # the new disk makes a round trip through a raw image. It holds
          # ~8 GB of actual data at this point, so this is a couple of
          # minutes of I/O in exchange for a mount with no block-device
          # plumbing in it. The virtual size survives the trip in both
          # directions, so the disk is still the size the installer made it.
          rm -f "$raw"
          qemu-img convert -p -O raw "$disk" "$raw"

          # Grow the root partition and its filesystem to fill the device,
          # before anything is written into them.
          #
          # This is not optional and it is not tidying. The installer sizes
          # the disk by growing its *virtual* size with `qemu-img resize`;
          # the partition table and the filesystem inside it still describe
          # the image make-disk-image built, which is sized to its
          # contents. Growing those two is normally the guest's job on
          # first boot -- `boot.growPartition` and then
          # `x-systemd.growfs`. But restore writes into this filesystem
          # *before* the guest has ever booted it, so without this the root
          # is 12.6 GiB with ~8 GB of store already in it, about 4 GB free,
          # and a 19 GB staged tree. It dies two thirds of the way through
          # rsync with ENOSPC on some file in a Steam runtime, which says
          # nothing whatsoever about partition tables.
          #
          # `,+` extends the last partition to the end of the device and
          # leaves room for the secondary GPT; sfdisk relocates that itself
          # and says so. The guest's growpart then finds nothing to do on
          # the first boot, which is the correct no-op.
          echo "==> Growing the root partition to fill the device."
          echo ', +' | sfdisk --no-reread --force -N 2 "$raw"

          # Read back where the root partition now is, by type GUID rather
          # than by number: it is the second one in make-disk-image's
          # layout, but its offset moves with `bootSize`.
          pstart=$(sfdisk -J "$raw" \
            | jq -r '.partitiontable.partitions[]
                     | select(.type == "0FC63DAF-8483-4772-8E79-3D69D8477DE4")
                     | .start' | head -1)
          psize=$(sfdisk -J "$raw" \
            | jq -r '.partitiontable.partitions[]
                     | select(.type == "0FC63DAF-8483-4772-8E79-3D69D8477DE4")
                     | .size' | head -1)
          case "''${pstart:-}''${psize:-}" in
            "" | *[!0-9]*)
              echo "Could not read the root partition's offset and size" >&2
              echo "from $raw (got start='$pstart' size='$psize')." >&2
              exit 1
              ;;
          esac
          echo "==> Root filesystem at sector $pstart, $(( psize / 2097152 )) GiB."

          # An exact loop device for that partition. --sizelimit matters:
          # without it the device runs to the end of the file, and
          # `resize2fs` with no explicit size would grow the filesystem
          # over the 33 sectors of backup GPT sitting behind it.
          loopdev=$(losetup -f --show \
            -o $(( pstart * 512 )) --sizelimit $(( psize * 512 )) "$raw")
          trap 'umount "$mnt" 2>/dev/null || true; losetup -d "'"$loopdev"'" 2>/dev/null || true' EXIT

          # resize2fs refuses to touch a filesystem that has not been
          # checked. This one was made minutes ago and never mounted, so
          # this is a formality rather than a repair; exit 1 means it
          # tidied something, anything above that wants a human.
          rc=0
          e2fsck -fp "$loopdev" || rc=$?
          if [ "$rc" -gt 1 ]; then
            echo "e2fsck exited $rc on the new disk's root filesystem." >&2
            exit 1
          fi

          echo "==> Growing the filesystem into it."
          resize2fs "$loopdev"

          mkdir -p "$mnt"
          mount "$loopdev" "$mnt"

          # Refuse up front rather than part way through. ENOSPC half way
          # into an rsync of the brain's home directory leaves a disk that
          # looks installed and is missing files nobody has a list of.
          need=$(du -sB1 "$stage" | cut -f1)
          avail=$(df -B1 --output=avail "$mnt" | tail -1)
          echo "==> Need $(( need / 1073741824 )) GiB, have $(( avail / 1073741824 )) GiB free."
          if [ "$need" -gt "$avail" ]; then
            echo "Not enough room in the new root filesystem for the staged" >&2
            echo "tree. Nothing has been copied. Either raise" >&2
            echo "virtualisation.diskSize and re-run 'install', or drop" >&2
            echo "something regenerable from $stage -- the Steam depot under" >&2
            echo ".local/share/Steam is usually the biggest single item." >&2
            exit 1
          fi

          for p in $paths; do
            if [ ! -d "$stage/$p" ]; then
              continue
            fi
            echo "==> Restoring /$p"
            mkdir -p "$mnt/$p"
            rsync -aH --numeric-ids --info=progress2 \
              "$stage/$p/" "$mnt/$p/"
          done

          umount "$mnt"
          # Release the loop device before converting: qemu-img reading the
          # file while a loop device still maps part of it is asking for a
          # torn read, and a leaked loop device makes the *next* run's
          # `losetup -f` pick a different one every time until there are
          # none left.
          losetup -d "$loopdev"
          trap - EXIT
          rmdir "$mnt" 2>/dev/null || true

          echo "==> Writing it back as qcow2."
          qemu-img convert -p -O qcow2 "$raw" "$disk.new"
          mv -f "$disk.new" "$disk"
          # Back to the owner QEMU runs as. Everything above ran as root,
          # so without this the VM cannot open its own disk and the unit
          # fails with a permission error that looks nothing like its cause.
          chown ${cfg.owner}:users "$disk"
          chmod 0600 "$disk"
          rm -f "$raw"

          echo "==> Starting ${name}."
          systemctl start ${name}.service

          echo ""
          echo "Done. Check it with:"
          echo "    journalctl -u ${name} -f"
          echo "    ${name}-console"
          echo ""
          echo "The old disk is still at $old ($(du -sh "$old" 2>/dev/null | cut -f1)),"
          echo "and $stage still holds the copy. Delete both once the new"
          echo "machine has proved itself -- not before."
        }

        case "$step" in
          stage)   do_stage ;;
          install) do_install ;;
          restore) do_restore ;;
          all)     do_stage; do_install; do_restore ;;
        esac
      '';
    };

  # A forward proxy, not a transparent one. TLS reaches it as a plaintext
  # CONNECT request naming the host, so the allowlist below applies without
  # anybody decrypting anything -- no CA to install in the guest, no
  # mailbox decrypted in order to protect it.
  escapeDots = lib.replaceStrings [ "." ] [ "\\." ];

  filterFileFor = name: inst:
    pkgs.writeText "${name}-allowed-domains.filter"
      (lib.concatMapStrings (d: "^${escapeDots d}$\n") inst.allowedDomains
        # One label-wise wildcard, for a service that spreads itself over a
        # subdomain tree nobody can enumerate -- Steam's connection
        # managers are ext1-<datacentre>.steamserver.net and the set turns
        # over. `([label].)*` matches any depth of subdomain and the bare
        # domain, and the leading anchor plus the escaped dots are what
        # keep it from matching evilsteamserver.net or
        # steamserver.net.attacker.example.
        + lib.concatMapStrings
          (d: "^([A-Za-z0-9_-]+\\.)*${escapeDots d}$\n")
          inst.allowedDomainSuffixes);

  # One filtering proxy per allowlisted VM, bound to that VM's gateway
  # address so it is unreachable from anywhere else -- this machine's LAN,
  # and every other VM. A unit of our own rather than services.tinyproxy,
  # which is a singleton: slots each need one (since 2026-10-27).
  proxyConfigFor = name: inst:
    let
      vm = plans.${name};
      # As services.tinyproxy writes it: `Key value`, a list as repeated
      # keys, booleans as yes/no, paths quoted.
      format = pkgs.formats.keyValue {
        listsAsDuplicateKeys = true;
        mkKeyValue = k: v:
          "${k} ${
            if v == true then "yes"
            else if v == false then "no"
            else if lib.types.path.check v then ''"${v}"''
            else lib.generators.mkValueStringDefault { } v}";
      };
    in
    format.generate "${name}-proxy.conf" {
      Port = vm.proxyPort;
      Listen = vm.hostAddress;
      Allow = [ vm.guestAddress ];
      Timeout = 600;

      # The filter file is the complete set of reachable hosts, not a
      # list of exceptions.
      FilterDefaultDeny = true;
      FilterExtended = true;
      FilterURLs = false;
      Filter = filterFileFor name inst;

      # Without this, CONNECT is a general-purpose TCP tunnel to any
      # port on an allowlisted host. 443 is all that is wanted.
      ConnectPort = [ 443 ];

      DisableViaHeader = true;
      LogLevel = "Notice";
    };
in
{
  imports = [ ./options.nix ];

  # No `enable` option: omni-laptop is the only host that imports this
  # aspect, and importing it is what asking for agent VMs means. An
  # instance set of `{ }` already configures nothing.
  config = {
    assertions = [
      {
        assertion = lib.all
          (inst: inst.egress != "allowlist"
            || inst.allowedDomains != [ ]
            || inst.allowedDomainSuffixes != [ ])
          (lib.attrValues active);
        message = ''
          my.agentVms: an instance with egress = "allowlist" and no
          allowedDomains or allowedDomainSuffixes can reach nothing at all.
          List the hosts it needs.
        '';
      }
      {
        # On an `open` instance every public address is already reachable,
        # so an exception there would be a no-op that reads like a
        # restriction. Refusing it keeps the option meaning one thing.
        assertion = lib.all (inst: inst.routedEgress == [ ] || inst.egress == "allowlist")
          (lib.attrValues active);
        message = ''
          my.agentVms: routedEgress only means something with
          egress = "allowlist". An open instance already reaches every
          public address.
        '';
      }
      {
        # Half a hole is worse than none: a destination set with no ports
        # (or ports with no destinations) silently generates no rule at
        # all, and the guest looks blocked for no visible reason.
        assertion = lib.all
          (inst: lib.all
            (hole: hole.destinations != [ ] && (hole.tcpPorts != [ ] || hole.udpPorts != [ ]))
            inst.routedEgress)
          (lib.attrValues active);
        message = ''
          my.agentVms: every routedEgress entry needs both `destinations`
          and at least one of `tcpPorts` / `udpPorts`. One without the
          other generates no rule, which looks like a blocked guest.
        '';
      }
      {
        # A routed hole is the one place in this module where a guest can
        # be handed an address of its own choosing, so it is also the one
        # place where a typo could point it back at this LAN -- the thing
        # the open-egress drops exist to prevent. Checked here rather than
        # trusted to review.
        assertion = lib.all
          (inst: lib.all (hole: lib.all (d: !(privateDestination d)) hole.destinations)
            inst.routedEgress)
          (lib.attrValues active);
        message = ''
          my.agentVms: a routedEgress destination is in private or
          link-local address space. A routed hole bypasses the proxy *and*
          the private-range drops, so it may only name public addresses.
        '';
      }
    ];

    boot.kernel.sysctl."net.ipv4.ip_forward" = 1;

    systemd.tmpfiles.rules = lib.flatten (lib.mapAttrsToList
      (name: inst:
        let vm = plans.${name}; in
        [
          "d ${vm.stateDir} 0750 ${cfg.owner} users -"
          "d ${vm.runDir}   0700 ${cfg.owner} users -"
          # The one-way drop box. ${cfg.owner} writes into it from here; the
          # guest gets it through virtiofsd's --readonly, which the guest
          # cannot override because virtiofsd is a host process.
          "d ${vm.shareDir} 0755 ${cfg.owner} users -"
          # And the other direction: writable in the guest, so the agent
          # can hand a file back without the drop box having to be
          # writable -- see vm.outboxDir in ../plan.nix.
          "d ${vm.outboxDir} 0755 ${cfg.owner} users -"
        ]
        ++ map (d: "d ${d} 0755 ${cfg.owner} users -") inst.extraDirs)
      active);

    # NetworkManager would otherwise try to autoconfigure the taps.
    networking.networkmanager.unmanaged =
      lib.mapAttrsToList (name: _: "interface-name:${plans.${name}.interface}") active;

    # An allowlisted guest has to reach the proxy, and our own `accept` in
    # the table above is not enough to get it there: in nftables `accept`
    # means "accept in this chain, then carry on to the next hook", so
    # NixOS's firewall at priority 0 still evaluates the packet and drops
    # it. Without this the guest fails closed on *everything*, including
    # the domains it is supposed to reach.
    #
    # Scoped to the VM's interface and the one port, so this opens nothing
    # on any real network interface.
    #
    # The resolver, for an instance with a routed exception, needs the same
    # treatment and for the same reason: our table accepts 53, NixOS's
    # firewall would still drop it.
    networking.firewall.interfaces = lib.mapAttrs'
      (name: inst:
        let vm = plans.${name}; in
        lib.nameValuePair vm.interface {
          allowedTCPPorts = [ vm.proxyPort ]
            ++ lib.optional (inst.routedEgress != [ ]) 53;
          allowedUDPPorts = lib.optional (inst.routedEgress != [ ]) 53;
        })
      allowlisted;

    # The proxies' own user; their units are in systemd.services below.
    users.users.tinyproxy = lib.mkIf (allowlisted != { }) {
      group = "tinyproxy";
      isSystemUser = true;
    };
    users.groups.tinyproxy = lib.mkIf (allowlisted != { }) { };

    # The resolver that makes a routed exception usable, and an allowlist in
    # its own right: every domain some exception names is forwarded to
    # `upstreamResolvers`, and nothing else is, because there is no default
    # upstream to fall back to. dnsmasq answers such a query REFUSED, which
    # fails fast in the guest the same way the proxy's 403 does.
    #
    # Bound to the VM's gateway address only, so it is not a resolver for
    # this machine's LAN, and `resolveLocalQueries = false` keeps it out of
    # the host's own /etc/resolv.conf -- NetworkManager still owns that.
    services.dnsmasq = lib.mkIf (routed != { }) (
      let
        name = lib.head (lib.attrNames routed);
        inst = routed.${name};
        vm = plans.${name};
        domains = lib.unique
          (lib.concatMap (hole: hole.resolveDomains) inst.routedEgress);
      in
      {
        enable = true;
        resolveLocalQueries = false;
        settings = {
          interface = vm.interface;
          listen-address = vm.hostAddress;
          # Rather than bind-interfaces: the tap is created and destroyed
          # with the VM's network unit, and bind-dynamic copes with an
          # interface that is not there yet instead of refusing to start.
          bind-dynamic = true;

          # No /etc/resolv.conf, no /etc/hosts: the only names this
          # resolver knows are the ones below, and the only thing it can
          # leak about the host is nothing.
          no-resolv = true;
          no-hosts = true;

          # Unqualified names and reverse lookups for private space never
          # leave this machine.
          domain-needed = true;
          bogus-priv = true;

          server = lib.concatMap
            (d: map (u: "/${d}/${u}") cfg.upstreamResolvers)
            domains;

          cache-size = 150;
        };
      }
    );

    systemd.services = lib.mkMerge [
      (lib.mapAttrs'
        (name: inst: lib.nameValuePair "${name}-proxy" {
          description = "Filtering proxy for ${name}";
          wantedBy = [ "multi-user.target" ];
          # It listens on the gateway address, which the network unit adds.
          after = [ "${name}-net.service" ];
          requires = [ "${name}-net.service" ];
          serviceConfig = {
            User = "tinyproxy";
            Group = "tinyproxy";
            Type = "simple";
            ExecStart = "${lib.getExe pkgs.tinyproxy} -d -c ${proxyConfigFor name inst}";
            ExecReload = "${pkgs.coreutils}/bin/kill -SIGHUP $MAINPID";
            KillSignal = "SIGINT";
            TimeoutStopSec = "30s";
            Restart = "on-failure";
          };
        })
        allowlisted)

      # Rules and tap device, one unit per VM.
      (lib.mapAttrs'
        (name: inst:
          let vm = plans.${name}; in
          lib.nameValuePair "${name}-net" {
            description = "Network isolation for ${name}";
            wantedBy = [ "multi-user.target" ];
            after = [ "network-pre.target" ];
            before = [ "network.target" ];
            path = [ pkgs.iproute2 pkgs.nftables ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true;
            };
            script = ''
              # Pre-created and owned by ${cfg.owner} so QEMU can attach to
              # it without any privilege of its own.
              if ! ip link show ${vm.interface} > /dev/null 2>&1; then
                ip tuntap add dev ${vm.interface} mode tap user ${cfg.owner}
              fi

              # Rules first, so the interface is never up unfiltered.
              nft -f ${rulesFor name inst}

              ip addr replace ${vm.hostAddress}/${toString vm.prefixLength} dev ${vm.interface}
              ip link set ${vm.interface} up
            '';
            preStop = ''
              ip link set ${vm.interface} down || true
              nft delete table inet ${name} || true
              ip link del ${vm.interface} || true
            '';
          })
        active)

      # Headless VMs run as a service; interactive ones are started by hand.
      # A slot is a service too, but nothing starts it except fleetd (see the
      # polkit rule below), and it runs once: the guest powers off when its
      # task is done, and a failure is the spawn's to report, not to retry.
      (lib.mapAttrs'
        (name: inst:
          let vm = plans.${name}; in
          lib.nameValuePair name {
            description = if inst.slot then "Agent slot ${name}" else "Agent VM ${name}";
            wantedBy = lib.optional (!inst.slot) "multi-user.target";
            after = [ "${name}-net.service" ];
            requires = [ "${name}-net.service" ];
            serviceConfig = {
              Type = "simple";
              User = cfg.owner;
              Group = "users";
              # ExecStart runs `nix build` first, so Type=simple is
              # deliberate: systemd considers the unit started immediately
              # and a cold build cannot trip a start timeout.
              ExecStart = lib.getExe (if inst.slot then slotLauncherFor name else launcherFor name inst);
              WorkingDirectory = vm.runDir;
              Restart = if inst.slot then "no" else "on-failure";
              RestartSec = "10s";

              # The host's share of the machine, defended from the guest.
              # A VM is the one service here that can ask for most of the
              # box and get it: QEMU's `-m` is a promise to the guest that
              # the host discovers the true cost of only as the guest
              # touches it, and nothing in `qemu-vm.nix` bounds it from
              # this side. See `memoryMax` above for why that is a freeze
              # rather than an OOM kill on a machine with no swap.
            } // lib.optionalAttrs (inst.memoryMax != null) {
              # A 1 GiB throttle band under the wall, so the two limits do
              # different jobs. At MemoryHigh the kernel reclaims this
              # cgroup's own page cache -- the store image and the virtiofs
              # traffic, both of which it can simply re-read -- and
              # throttles the allocator, instead of pushing the host's text
              # pages out. That is pressure, not a wall: a guest that
              # overshoots briefly pays in throughput and the host does not
              # notice. Setting this *equal* to MemoryMax would skip the
              # band entirely and turn every overshoot straight into a
              # kill, which is the failure this is meant to avoid.
              MemoryHigh = "${toString (inst.memoryMax - 1024)}M";

              # The wall. Reached only by a guest that keeps allocating
              # through the band above, which means it is genuinely
              # runaway rather than busy, so the cgroup OOM killer takes
              # QEMU. `OOMPolicy=stop` plus the `Restart=on-failure` above
              # makes that a ten-second outage for the guest instead of a
              # power cycle for the host.
              MemoryMax = "${toString inst.memoryMax}M";

              # Let systemd-oomd act before the wall is hit, so the common
              # case is a kill at sustained pressure rather than at the
              # hard ceiling. Opting in per-unit is required: `oomctl`
              # otherwise reports no monitored cgroups at all, because the
              # inherited default is `auto` the whole way up and the
              # swap-based half of oomd is dead on a swapless host anyway.
              ManagedOOMMemoryPressure = "kill";

              # Interactivity is the other half of the symptom. Software
              # rendering pins every vCPU it is given, and the default
              # weight makes those vCPUs equal claimants with the
              # compositor. They are not equal: a dropped frame in the
              # guest is a slower screenshot, a dropped frame on the host
              # is the machine appearing to hang. Only binds under
              # contention, so it costs the guest nothing when the host is
              # idle.
              CPUWeight = 20;
              IOWeight = 20;
            };
          })
        (lib.filterAttrs (_: inst: inst.headless || inst.slot) active))

      # The build that produces a guest, as opposed to the guest itself.
      # The weights above only cover QEMU, and `nix build` is not where the
      # work happens: the client just blocks on the daemon while every
      # compiler runs in system.slice/nix-daemon.service, which inherits
      # the default weight and so competes with the compositor on equal
      # terms. That is how a routine guest rebuild took this host down on
      # 2026-10-13 -- an onnxruntime compile saturated all twelve cores,
      # libinput started logging input lag, and the machine looked hung
      # enough to be power-cycled by hand, which cost an unclean shutdown
      # and an ext4 journal replay. Same argument as the per-VM weights: a
      # slower build is a slower build, a starved compositor is an
      # apparently dead laptop. Contention-only here too, so an idle host
      # still builds at full speed.
      #
      # Weight is a share of a contended CPU, not a latency guarantee; it
      # does not stop nix from making more runnable threads than there are
      # cores. If the stutter comes back under load, the next lever is
      # bounding that parallelism (`nix.settings.max-jobs` / `cores`) or a
      # hard `CPUQuota` that leaves the host a core, which costs idle
      # throughput in exchange.
      {
        nix-daemon.serviceConfig = {
          CPUWeight = 20;
          IOWeight = 20;
        };
      }

      # dnsmasq listens on the gateway address, which the VM's network unit
      # is what creates. bind-dynamic above means a late address is not
      # fatal, but ordering after that unit keeps the common case from
      # having a window where the guest's first query goes nowhere.
      (lib.mkIf (routed != { })
        (let name = lib.head (lib.attrNames routed); in {
          dnsmasq = {
            after = [ "${name}-net.service" ];
            wants = [ "${name}-net.service" ];
          };
        }))
    ];

    # fleetd runs as the owner and starts and stops the slots, which are
    # system units (like every VM here, so `<name>-ssh` and the journal
    # work the same). This lets the owner do that to those units and no
    # others, without a password.
    security.polkit.extraConfig = lib.mkIf (manifest.slots != { }) ''
      polkit.addRule(function (action, subject) {
        var slots = ${builtins.toJSON (lib.mapAttrsToList (_: s: s.unit) manifest.slots)};
        if (action.id == "org.freedesktop.systemd1.manage-units"
            && subject.user == ${builtins.toJSON cfg.owner}
            && slots.indexOf(action.lookup("unit")) >= 0) {
          return polkit.Result.YES;
        }
      });
    '';

    environment.etc."corkboard/fleet.json" = lib.mkIf (manifest.slots != { }) {
      text = builtins.toJSON manifest;
    };

    # The queue: spawns wait here until a slot is free and the budget has
    # room, and it collects what each one hands back.
    systemd.user.services.corkboard-fleetd = lib.mkIf (manifest.slots != { } && cfg.package != null) {
      description = "corkboard fleet: starts agents in slots";
      wantedBy = [ "default.target" ];
      unitConfig.ConditionUser = cfg.owner;
      path = [ pkgs.systemd pkgs.git pkgs.coreutils ];
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/corkboard-fleetd";
        Restart = "on-failure";
        RestartSec = "5s";
      };
    };

    environment.systemPackages =
      lib.optional (manifest.slots != { } && cfg.package != null) cfg.package
      # A slot has no launcher of its own to type: fleetd starts it.
      ++
      (lib.mapAttrsToList launcherFor (lib.filterAttrs (_: inst: !inst.slot) active))
      # A viewer only means something for a VM with a screen.
      ++ (lib.mapAttrsToList (name: _: viewerFor name)
        (lib.filterAttrs (_: inst: !inst.headless && !inst.slot) active))
      # ...and a console only for one without.
      ++ (lib.mapAttrsToList (name: _: consoleFor name)
        (lib.filterAttrs (_: inst: inst.headless || inst.slot) active))
      # A guest that runs sshd gets the nicer way in as well. Not instead
      # of the console: see the option, and `sshFor`.
      ++ (lib.mapAttrsToList (name: _: sshFor name)
        (lib.filterAttrs (_: inst: inst.sshLogin) active))
      # A guest that owns its filesystem needs a way to bring one into
      # existence, and -- once -- a way to move onto it from the old one.
      # Both only for such a guest: on a VM whose root image the launcher
      # still creates, an installer would write a disk nothing boots and a
      # migrator would have nowhere to migrate to.
      ++ (lib.concatMap (name: [ (installerFor name) (migratorFor name) ])
        (lib.attrNames (lib.filterAttrs (_: inst: inst.ownsDisk) active)));
  };
}
