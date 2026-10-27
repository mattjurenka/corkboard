# What a host may ask the agent VMs for: the option surface, and nothing else.
#
# Split out of ./host.nix on 2026-10-17, which was 1771 lines of helpers,
# options and config in one file. These lines reference none of that file's
# let-bindings -- they are declarations, read far more often than the plumbing
# behind them -- so they are the one part that could be lifted without deciding
# anything.
#
# What stayed in ./host.nix: the nftables rule builders, the per-instance
# launcher, installer, migrator, console, viewer and ssh wrappers, and the
# config that wires them together.
{ lib, ... }: {
  options.my.agentVms = {
    plans = lib.mkOption {
      type = lib.types.attrsOf lib.types.raw;
      default = { };
      description = ''
        Address plans and paths, keyed by VM name, as `lib.fleet.mkPlan` makes
        them. The guests read the same plans for their own addresses, so the
        installing flake defines them once and hands them to both. An instance
        with no plan here is ignored.
      '';
    };

    templates = lib.mkOption {
      type = lib.types.attrsOf lib.types.raw;
      default = { };
      description = ''
        The fleet's resolved templates (`mkFleet`'s `templates`). Those with
        `spawnable` are what a slot can be started as; fleetd reads their
        sizes and approval rule from /etc/corkboard/fleet.json.
      '';
    };

    brains = lib.mkOption {
      type = lib.types.attrsOf lib.types.raw;
      default = { };
      description = ''
        The fleet's brains (`mkFleet`'s `brains`): each one's Claude account,
        which its agents run as, and so do the brainless agents it spawns.
      '';
    };

    defaultAccount = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "personal";
      description = ''
        The account a template with no brain runs as when the user spawns
        it without `--account`. Each account is a token from `claude
        setup-token` at ~/.local/state/corkboard/fleet/accounts/<name>.
      '';
    };

    memoryBudget = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = null;
      example = 16384;
      description = ''
        MiB the agents here may have between them: every running headless
        VM's `memoryMax`, plus each running slot's template. fleetd leaves a
        spawn queued rather than start it past this. Null for no limit.
      '';
    };

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = ''
        corkboard's fleet tools (`corkboard-fleetd`, `corkboard-fleet`).
        Set by the flake's `nixosModules.fleetHost`.
      '';
    };

    owner = lib.mkOption {
      type = lib.types.str;
      default = "matthew";
      description = ''
        User who launches the VMs. QEMU and virtiofsd run as this user, so
        it owns the tap devices and is the only account that can put files
        into a drop box. Its uid must match the guest user's uid, or
        virtiofs writes to a writable share fail with EACCES.
      '';
    };

    upstreamResolvers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "1.1.1.1" "1.0.0.1" ];
      description = ''
        Where the gateway's resolver forwards the queries it is willing to
        answer, for guests that have a `routedEgress` entry. Only consulted
        for the domains those entries name; there is deliberately no
        default upstream, so anything else is REFUSEd.
      '';
    };

    flake = lib.mkOption {
      type = lib.types.str;
      default = "/home/matthew/nixosconfig";
      description = "Flake the launchers build the VMs from.";
    };

    instances = lib.mkOption {
      default = { };
      description = ''
        VMs to run on this host, keyed by a name in
        `flake.lib.agentVm.instances`.
      '';
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          egress = lib.mkOption {
            type = lib.types.enum [ "open" "allowlist" ];
            default = "open";
            description = ''
              `open`: the guest reaches the public internet directly and
              nothing private. Right for a browser.

              `allowlist`: the guest has no route off the machine at all,
              and reaches only the hosts in `allowedDomains`, only through
              a filtering proxy on the host. Right for anything holding a
              credential worth exfiltrating.
            '';
          };

          allowedDomains = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = ''
              Exact hostnames the guest may reach when `egress` is
              `allowlist`. Matched anchored, so a subdomain is not implied:
              list every host you actually need.
            '';
          };

          routedEgress = lib.mkOption {
            default = [ ];
            description = ''
              Destinations this guest may reach *directly*, with no proxy
              in the path -- for a protocol the proxy cannot carry.

              This is a bigger step than adding a host to
              `allowedDomains`: that widens what the filter permits, this
              one leaves the filter out entirely. Each entry is scoped to a
              destination set and a port set (both required, and applied in
              the same rule, so neither half is ever open alone), and
              carries a `reason` that is written into the generated
              ruleset. Granting any entry also gives the guest a resolver
              on the gateway -- dnsmasq, answering only for
              `resolveDomains` and REFUSEing every other query.

              Destinations are CIDRs, not hostnames: nftables cannot
              resolve, so a service behind a shifting CDN address set
              cannot be expressed here and should not be forced into it.
            '';
            type = lib.types.listOf (lib.types.submodule {
              options = {
                reason = lib.mkOption {
                  type = lib.types.str;
                  description = ''
                    Why this hole exists, in prose. Written into the .nft
                    file as comments, so the ruleset on the machine
                    explains itself.
                  '';
                };

                destinations = lib.mkOption {
                  type = lib.types.listOf lib.types.str;
                  default = [ ];
                  description = ''
                    IPv4 prefixes the guest may reach. Keep these to
                    address space the service's operator actually owns.
                  '';
                };

                tcpPorts = lib.mkOption {
                  type = lib.types.listOf lib.types.str;
                  default = [ ];
                  description = ''
                    TCP destination ports, as nftables writes them: single
                    ports or `low-high` ranges.
                  '';
                };

                udpPorts = lib.mkOption {
                  type = lib.types.listOf lib.types.str;
                  default = [ ];
                  description = "UDP destination ports, same spelling.";
                };

                resolveDomains = lib.mkOption {
                  type = lib.types.listOf lib.types.str;
                  default = [ ];
                  description = ''
                    Domains the guest may resolve, matched including
                    subdomains. Everything not listed by some entry is
                    REFUSEd by the gateway's resolver, so resolution is an
                    allowlist in its own right.
                  '';
                };
              };
            });
          };

          allowedDomainSuffixes = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = ''
              Domains the guest may reach *including every subdomain*, for
              a service whose hostnames cannot be listed -- a CDN, or a
              server pool that is renamed as it is rebalanced.

              Wider than `allowedDomains` and not a substitute for it: one
              entry here grants a whole tree, so prefer an exact host
              whenever the set of hosts is knowable. Still bounded by the
              proxy's `ConnectPort`, and still a *name* allowlist -- the
              proxy resolves the name itself and the guest never chooses an
              address.
            '';
          };

          slot = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              A slot for spawned agents: a system unit nothing starts but
              fleetd, which boots whichever spawnable template it claimed the
              slot for, on an empty disk, once. Plan it like any other VM; its
              egress has to cover every spawnable template's.
            '';
          };

          headless = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Run the VM as a system service that is up whenever the
              machine is, instead of an interactive `<name>` launcher. A
              headless VM gets no SPICE viewer wrapper.
            '';
          };

          memoryMax = lib.mkOption {
            type = lib.types.nullOr lib.types.ints.positive;
            default = null;
            example = 14336;
            description = ''
              Hard cgroup ceiling, in MiB, on everything the VM costs the
              host: QEMU's guest RAM, its own allocations, and the page
              cache charged to it by virtiofsd and the Nix store image.
              MiB rather than a `systemd.resource-control` size string so
              that it is the same unit as the guest's own `memorySize`,
              which is the number it has to be set against, and so the
              throttle band below it can be derived rather than restated.

              This exists because the guest's `memorySize` is a *promise to
              the guest*, not a limit on the host -- QEMU faults guest pages
              in lazily, so the host only learns how big the VM really is as
              the guest touches it. On a machine with no swap that discovery
              is not survivable: the kernel's only reclaim target is page
              cache, so it evicts the compositor's and libinput's own text
              pages and immediately faults them back, forever. The OOM
              killer never fires, because reclaim keeps "succeeding". The
              host does not crash -- it goes infinitely slow with the screen
              still lit and the cursor still moving, which is the one
              failure mode that cannot be debugged from the machine itself.

              Set this above what the VM needs in normal operation and below
              what the host needs to stay alive, and the trade is made the
              right way round: the guest is killed, and `Restart=on-failure`
              brings it back ten seconds later, instead of the host being
              wedged until it is power-cycled.
            '';
          };

          extraDirs = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = ''
              Further host directories to create before the VM starts, for
              shares other than the drop box. virtiofsd needs its source to
              exist at launch.
            '';
          };

          ownsDisk = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              The guest owns its filesystem: a complete NixOS installation
              on its own GPT disk -- its own ESP, its own bootloader, and
              `/nix/store` as a directory on its own root -- instead of a
              root image the host regenerates a store layer under on every
              launch.

              This is a claim about the guest's configuration, not a switch
              that changes it. Set it for a guest whose
              `virtualisation` block has `useNixStoreImage = false`,
              `writableStore = false`, `directBoot.enable = false` and
              `useEFIBoot = true`, which together are what make the disk
              the only thing it boots. The two have to agree: the host side
              is what stops the launcher creating a bootless image, keeps
              the firmware's variable store somewhere stable, and provides
              `<name>-install-disk` and `<name>-migrate-disk`.

              What it buys is the thing the overlay could not: nix works
              normally. One store with one owner, so a path in the database
              is a path on the disk; `nixos-rebuild switch` survives a
              power cycle; `nix profile install` persists; a bad generation
              is recoverable from the guest's own boot menu. The old
              arrangement had the host's evaluation as the lower layer of
              the guest's store, and every nix failure in that guest came
              out of the two disagreeing.

              What it costs: builds happen in the guest. The host's store
              is no longer a free cache, so uncached closures compile on
              the guest's vCPUs. On this host that is the better side of
              the trade -- a compile in the host's nix-daemon is what took
              the machine down on 2026-10-13 -- but it is slower, and the
              disk has to be big enough for a store as well as the work.
            '';
          };

          sshLogin = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              The guest runs an SSH daemon on its own tap address, so this
              host gets `<name>-ssh` alongside `<name>-console`.

              Like `ownsDisk`, this is a claim about the guest's
              configuration rather than a switch that changes it: set it
              for a guest whose config enables `services.openssh` and
              authorizes a key this host's owner holds. The two have to
              agree, and the wrapper is the only thing this side adds --
              nothing in the firewall moves, because the input chain
              already accepts the replies to connections this machine
              opens and the guest already accepts everything from its
              gateway.

              What it is for: consoles are a fixed, small number -- one
              chardev each, one client each -- and a guest running a
              long-lived agent session spends them, which is exactly what
              happened to brain-vm's three. SSH multiplexes as many
              sessions as are wanted over the address that is already
              there, and carries a real pty, so the window size crosses the
              link instead of every session starting at 80x24 with no
              SIGWINCH. It does not replace the console: that one works
              before the network does.
            '';
          };
        };
      });
    };
  };
}
