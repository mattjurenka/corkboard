# corkboard's fleet on a NixOS host: a pool of slots that spawned agents run
# in, the templates they can be, and what the host lends them. Everything a
# spawn needs is built with the host (each template's guest included), so
# a spawn evaluates nothing; the host's own config only says how much.
#
#   services.corkboard.fleet = {
#     enable = true;
#     owner = "matthew";
#     slots = 8;
#     memoryBudget = 14336;
#     offer = { memory = 12288; cores = 6; };
#     bindings.work.shares.vault = { source = "/home/me/vault"; target = "/mnt/vault"; writable = true; };
#     guestModules = [ ... ];   # Claude Code, login keys, time zone
#   };
#
# Who a spawn works for is corkboard's (its brains); a host only says what
# memory it has for one, and what the brains' agents reach.
#
# It drives the VM plumbing in ./host.nix (`my.agentVms`), which a host may
# also use for VMs of its own.
{ nixosSystem }:
{ config, lib, ... }:
let
  cfg = config.services.corkboard.fleet;
  fleetLib = import ../lib.nix { inherit lib; };
  pool = import ../pool.nix { size = cfg.slots; };

  fleet = fleetLib.mkFleet {
    inherit nixosSystem;
    inherit (cfg) bindings corkboardHost;
    capabilities = {
      # Every agent is Claude Code. Its package is the host's to give
      # (guestModules); these are the hosts it talks to.
      claude-code = {
        targets = [ "vm" "oci" ];
        egress = [ "api.anthropic.com" "platform.claude.com" "claude.ai" "claude.com" "code.claude.com" ];
      };
      inherit (fleetLib.capabilities) coding;
    } // cfg.capabilities;
    environments.${cfg.environment} = { kind = "vm"; inherit (cfg) provides; };
    templates = lib.mapAttrs
      (_: t: { environments = [ cfg.environment ]; spawnable = true; } // t)
      cfg.templates;
    slotModules = cfg.guestModules;
    ownerUid = cfg.uid;
  };

  # Big enough for the largest VM the host offers, QEMU's 512 MiB and the
  # 1 GiB throttle band (host.nix's assertion).
  largest = if cfg.offer.memory != null then cfg.offer.memory
    else lib.foldl' lib.max 0 (lib.mapAttrsToList (_: t: t.memory) fleet.templates);
in
{
  imports = [
    ./host.nix
    (lib.mkRemovedOptionModule [ "services" "corkboard" "fleet" "brains" ] ''
      A brain is corkboard's now (its Brains tab), with its account and credentials.
      What stays here: bindings.<brain>.shares for its memory.'')
    (lib.mkRemovedOptionModule [ "services" "corkboard" "fleet" "egress" ] ''
      Every slot reaches the whole public internet now, so there is no list of hosts to keep.'')
  ];

  options.services.corkboard.fleet = with lib; {
    enable = mkEnableOption "corkboard's fleet: spawned agents in VMs of their own";

    owner = mkOption {
      type = types.str;
      example = "matthew";
      description = "The user fleetd runs as, whose uid the guests' claude has (virtiofs passes it through).";
    };

    uid = mkOption {
      type = types.int;
      default = config.users.users.${cfg.owner}.uid;
      defaultText = literalExpression "config.users.users.${owner}.uid";
      example = 1002;
      description = "The owner's uid, which the guests' claude has, or virtiofs refuses its writes. Needed when NixOS assigns it.";
    };

    slots = mkOption {
      type = types.ints.between 1 64;
      default = 8;
      description = ''
        How many agents may run at once, at most: each is a tap device and a
        firewall table, idle until a spawn takes it. The memory budget is
        what decides how many actually do.
      '';
    };

    memoryBudget = mkOption {
      type = types.nullOr types.ints.positive;
      default = null;
      example = 14336;
      description = "MiB the agents may have between them, each counted at its memory plus 512. Null for no limit.";
    };

    offer = {
      memory = mkOption {
        type = types.nullOr types.ints.positive;
        default = null;
        description = "The most MiB one agent's VM may ask for. Null for whatever fits the budget.";
      };
      cores = mkOption {
        type = types.nullOr types.ints.positive;
        default = null;
        description = "The most vCPUs one agent's VM may ask for.";
      };
    };

    environment = mkOption {
      type = types.str;
      default = config.networking.hostName;
      defaultText = literalExpression "config.networking.hostName";
      description = "This host's name in the fleet: where a spawn says it runs.";
    };

    provides = mkOption {
      type = types.listOf types.str;
      default = [ "kvm" ];
      example = [ "kvm" "gpu" "display" ];
      description = "What this host gives the capabilities that need it.";
    };

    templates = mkOption {
      type = types.attrsOf types.attrs;
      default = { coding = { capabilities = [ "claude-code" "coding" ]; }; };
      description = ''
        What an agent can be started as here: `mkFleet` templates
        (capabilities, memory, cores, modules), each spawnable on this host.
        What it runs inside is the spawner's (its shell), and who it works
        for is the spawn's (its brain).
      '';
    };

    capabilities = mkOption {
      type = types.attrsOf types.attrs;
      default = { };
      description = "Capabilities besides corkboard's own (`claude-code`, `coding`).";
    };

    bindings = mkOption {
      type = types.attrsOf types.attrs;
      default = { };
      example = literalExpression ''{ work.shares.vault = { source = "/home/me/vault"; target = "/mnt/vault"; writable = true; }; }'';
      description = ''
        The memory this host has for a brain, by the brain's name: `shares`,
        virtiofs shares every spawn for it mounts here. A brain with none runs
        here without them.
      '';
    };

    defaultAccount = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "personal";
      description = "The Claude account a brainless agent runs as when nobody says (a token in ~/.local/state/corkboard/fleet/accounts).";
    };

    guestModules = mkOption {
      type = types.listOf types.deferredModule;
      default = [ ];
      description = "NixOS modules every agent's guest gets: Claude Code itself, login keys, a time zone.";
    };

    corkboardHost = mkOption {
      type = types.str;
      default = "portal.corkboard.fyi";
      description = "corkboard's Worker, which every agent reports to.";
    };
  };

  config = lib.mkIf cfg.enable {
    my.agentVms = {
      inherit (cfg) owner memoryBudget offer defaultAccount;
      inherit (fleet) templates bindings;
      plans = pool;
      instances = lib.mapAttrs
        (_: _: {
          slot = true;
          # The public internet, and nothing private (host.nix).
          egress = "open";
          sshLogin = true;
          memoryMax = largest + 1536;
        })
        pool;
      slotRunners = lib.mapAttrs'
        (name: guest: lib.nameValuePair (lib.removeSuffix "@slot" name) guest.config.system.build.vm)
        (lib.filterAttrs (name: _: lib.hasSuffix "@slot" name) fleet.nixosConfigurations);
    };
  };
}
