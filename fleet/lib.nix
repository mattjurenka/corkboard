# The fleet: capabilities, environments and templates, and the check that
# every template can run everywhere it says it can. See
# .agent/plans/agent-fleet.md for what each of these is.
#
# `mkFleet` takes them and the installing flake's `nixosSystem`, and gives
# back the resolved templates and a guest per template that runs in a `vm`
# environment. Anything that cannot be placed is an evaluation error naming
# every such template at once, never a runtime one.
#
# A brain is corkboard's (the hosted Worker's brains.ts), and a spawn's, not a
# template's: what stays here is what only the host knows, its bindings, the
# memory it mounts in a brain's spawns (.agent/plans/brains.md).
{ lib }:
let
  inherit (lib) concatMap concatStringsSep elem foldl' max subtractLists unique;

  # The agent kinds a template can run (its `agent`, Claude Code's by default).
  agents = [ "claude" "opencode" "gemini" "codex" ];

  capability = name: c: {
    inherit name;
    # NixOS modules the capability adds to a guest (or to an image).
    modules = c.modules or [ ];
    # Minimums, in MiB and vCPUs. A template takes the largest.
    memory = c.memory or 0;
    cores = c.cores or 0;
    # MiB of disk, for a guest whose disk the fleet sizes (a slot's).
    disk = c.disk or 0;
    # What the environment must provide: "gpu", "display", "kvm", ...
    needs = c.needs or [ ];
    # Other capabilities this one is no use without.
    requires = c.requires or [ ];
    # Hosts it must reach, added to the template's allowlist.
    egress = c.egress or [ ];
    # Secrets it holds. Any makes the template one a brain cannot spawn
    # without the user's approval.
    credentials = c.credentials or [ ];
    # What it can be built as: "vm" (a NixOS guest) and/or "oci" (an image
    # for a gVisor container, which has no systemd).
    targets = c.targets or [ "vm" ];
  };

  binding = name: b: {
    inherit name;
    # The brain's memory on this host, as virtiofs shares every spawn for the
    # brain mounts, keyed by name: { source; target; writable ? false;
    # description ? ""; }. Shared, so what one agent writes the others see.
    # Resident guests declare their own shares.
    shares = lib.mapAttrs (_: s: { writable = false; description = ""; } // s) (b.shares or { });
  };

  environment = name: e: {
    inherit name;
    # The target its agents are built as: "vm" or "oci".
    kind = e.kind;
    provides = e.provides or [ ];
    # MiB the environment can give its agents at once, or null for no limit.
    memoryBudget = e.memoryBudget or null;
  };

  mkFleet =
    { bindings ? { }
    , capabilities ? { }
    , environments ? { }
    , templates ? { }
      # Modules every slot guest gets (its login keys, say). Which slots a
      # host has is its own (fleet/host, `mkPool`): a slot guest boots in any.
    , slotModules ? [ ]
      # The host user who runs the slots (fleet/host's `owner`). virtiofs
      # passes uids through, so the guest's user has to be this uid to write
      # to the outbox or a brain's memory.
    , ownerUid ? null
      # The installing flake's, so guests are built from its nixpkgs.
    , nixosSystem ? null
      # corkboard's Worker: every spawned agent reports to its card there,
      # with its spawn token.
    , corkboardHost ? "portal.corkboard.fyi"
    }:
    let
      caps = lib.mapAttrs capability capabilities;
      bindings' = lib.mapAttrs binding bindings;
      envs = lib.mapAttrs environment environments;

      # The capabilities a template asked for, then whatever they require, in
      # that order: module order is the order a guest's lists merge in.
      closure = names:
        let
          go = seen: todo:
            if todo == [ ] then seen
            else
              let n = builtins.head todo; rest = builtins.tail todo; in
              if elem n seen then go seen rest
              else if !(caps ? ${n}) then throw "fleet: unknown capability `${n}`"
              else go (seen ++ [ n ]) (rest ++ caps.${n}.requires);
        in
        go [ ] names;

      resolve = name: t:
        let
          capNames = closure (t.capabilities or [ ]);
          cs = map (n: caps.${n}) capNames;
          credentials = unique (concatMap (c: c.credentials) cs);
        in
        if t ? brain then throw "fleet: template `${name}`: a brain is a spawn's now, not a template's; bind its memory with `bindings.${t.brain}.shares`"
        else if !(elem (t.agent or "claude") agents) then throw "fleet: template `${name}`: no agent `${t.agent}`; one of ${concatStringsSep ", " agents}"
        else {
          inherit name capNames credentials;
          # The agent kind its guest runs (nvim/lua/corkboard/agent/): Claude
          # Code, or an ACP one (fleet/guest/acp.ts).
          agent = t.agent or "claude";
          environments = t.environments or [ ];
          needs = unique (concatMap (c: c.needs) cs);
          memory = foldl' max (t.memory or 0) (map (c: c.memory) cs);
          cores = foldl' max (t.cores or 0) (map (c: c.cores) cs);
          disk = foldl' max (t.disk or 0) (map (c: c.disk) cs);
          # Started on demand in a slot, rather than a VM of its own.
          spawnable = t.spawnable or false;
          egress = unique (concatMap (c: c.egress) cs);
          # What its spawns may do on the forge (the leader's, which fleetd
          # serves on the slot's gateway: fleet/fleetd/forge.ts), granted
          # to each at its claim (.agent/plans/forge-keys.md), or null:
          # { repos = [ "owner/name" "owner/*" ]; permissions = { contents =
          # "write"; pull_requests = "read"; ... }; refs ? [ "agent/{spawn}/*" ];
          # delete ? false; }, {spawn} being each spawn's id. Only a sealed fleet (its node a device) signs one.
          git = t.git or null;
          # The approval rule: a template with no credentials (nor git) runs
          # whoever asks; one with any needs the user's yes when a brain asks.
          needsApproval = credentials != [ ] || (t.git or null) != null;
          # Where it can be built: every capability has to agree.
          targets = foldl' (acc: c: builtins.filter (k: elem k c.targets) acc) [ "vm" "oci" ] cs;
          # The template's own modules first (a guest's base: its machine,
          # its network), then each capability's.
          modules = (t.modules or [ ]) ++ concatMap (c: c.modules) cs;
        };

      resolved = lib.mapAttrs resolve templates;

      placementErrors = t: concatMap
        (e:
          if !(envs ? ${e}) then [ "${t.name} on ${e}: no such environment" ]
          else
            let
              env = envs.${e};
              unmet = subtractLists env.provides t.needs;
            in
            lib.optional (unmet != [ ])
              "${t.name} on ${e}: needs ${concatStringsSep ", " unmet}; ${e} provides ${if env.provides == [ ] then "none" else concatStringsSep ", " env.provides}"
            ++ lib.optional (!elem env.kind t.targets)
              "${t.name} on ${e}: ${e} runs ${env.kind} agents; ${concatStringsSep ", " (map (c: c.name) (builtins.filter (c: !elem env.kind c.targets) (map (n: caps.${n}) t.capNames)))} cannot be built as ${env.kind}")
        t.environments;

      errors = concatMap placementErrors (lib.attrValues resolved);

      checked = x:
        if errors == [ ] then x
        else throw "fleet: templates that cannot be placed:\n  ${concatStringsSep "\n  " errors}";

      # The guest's own sizes still decide; this only refuses one that is
      # smaller than its capabilities need. No options, so a guest's manual
      # (and so its derivation) is untouched.
      guestCheck = t: { config, ... }: {
        assertions = [
          {
            assertion = config.virtualisation.memorySize >= t.memory;
            message = "fleet: ${t.name} has ${toString config.virtualisation.memorySize} MiB; its capabilities need ${toString t.memory}";
          }
          {
            assertion = config.virtualisation.cores >= t.cores;
            message = "fleet: ${t.name} has ${toString config.virtualisation.cores} cores; its capabilities need ${toString t.cores}";
          }
        ];
      };

      runsAsVm = t: lib.any (e: (envs.${e}.kind or null) == "vm") t.environments;

      # A spawnable template as a slot's guest: the slot guest, then the
      # template. Named `<template>@slot`, which every slot's launcher builds,
      # and `<template>+<brain>@slot` with a bound brain's memory mounted.
      slotGuest = t: brain: shares: checked (nixosSystem {
        modules = [ (import ./guest/slot.nix { inherit ownerUid corkboardHost brain shares; template = t; }) ]
          ++ slotModules ++ t.modules ++ [ (guestCheck t) ];
      });
      spawnables = lib.attrValues (lib.filterAttrs (_: t: t.spawnable && runsAsVm t) resolved);
      slotGuests = lib.listToAttrs (concatMap
        (t: [ (lib.nameValuePair "${t.name}@slot" (slotGuest t null { })) ]
          ++ lib.mapAttrsToList (b: binding: lib.nameValuePair "${t.name}+${b}@slot" (slotGuest t b binding.shares))
            (lib.filterAttrs (_: b: b.shares != { }) bindings'))
        spawnables);
    in
    {
      templates = lib.mapAttrs (_: checked) resolved;
      environments = envs;
      # Each bound brain's shares, by name, for fleetd: a spawn for one with
      # any boots `<template>+<brain>`.
      bindings = lib.mapAttrs (_: b: { shares = lib.attrNames b.shares; }) bindings';
      inherit errors;

      nixosConfigurations = lib.mapAttrs
        (_: t: checked (nixosSystem { modules = t.modules ++ [ (guestCheck t) ]; }))
        (lib.filterAttrs (_: t: runsAsVm t && !t.spawnable) resolved)
      // slotGuests;
    };

  # Capabilities corkboard provides, for an installing flake to use as they
  # are or extend.
  capabilities = {
    coding = {
      modules = [ ./caps/coding.nix ];
      memory = 4096;
      cores = 2;
      disk = 32768;
      egress = [
        "cache.nixos.org"
        "channels.nixos.org"
        "github.com"
        "api.github.com"
        "codeload.github.com"
        "objects.githubusercontent.com"
        "raw.githubusercontent.com"
        "registry.npmjs.org"
        "pypi.org"
        "files.pythonhosted.org"
      ];
      targets = [ "vm" "oci" ];
    };
    # A headless Chromium its agent drives, with whichever extensions it
    # asks for each run (fleet/caps/browser-mcp.ts).
    browser = {
      modules = [ ./caps/browser.nix ];
      memory = 4096;
      cores = 2;
      disk = 16384;
    };
    # One Forgejo Actions job per VM (fleet/fleetd/actions.ts).
    actions = {
      modules = [ ./caps/actions.nix ];
      memory = 1536;
      cores = 2;
      disk = 16384;
    };
  };
in
{
  inherit mkFleet capabilities;
}
