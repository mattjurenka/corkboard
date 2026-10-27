# The fleet: brains, capabilities, environments and templates, and the check
# that every template can run everywhere it says it can. See
# .agent/plans/agent-fleet.md for what each of these is.
#
# `mkFleet` takes the four sets and the installing flake's `nixosSystem`, and
# gives back the resolved templates and a guest per template that runs in a
# `vm` environment. Anything that cannot be placed is an evaluation error
# naming every such template at once, never a runtime one.
{ lib }:
let
  inherit (lib) concatMap concatStringsSep elem foldl' max subtractLists unique;

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

  brain = name: b: {
    inherit name;
    modules = b.modules or [ ];
    egress = b.egress or [ ];
    credentials = b.credentials or [ ];
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
    { brains ? { }
    , capabilities ? { }
    , environments ? { }
    , templates ? { }
      # Slots for spawnable templates, as `mkPlan` plans keyed by name, and
      # modules every slot guest gets (its login keys, say).
    , slots ? { }
    , slotModules ? [ ]
      # The installing flake's, so guests are built from its nixpkgs.
    , nixosSystem ? null
    }:
    let
      caps = lib.mapAttrs capability capabilities;
      brains' = lib.mapAttrs brain brains;
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
          b =
            if (t.brain or null) == null then null
            else brains'.${t.brain} or (throw "fleet: template `${name}`: unknown brain `${t.brain}`");
          capNames = closure (t.capabilities or [ ]);
          cs = map (n: caps.${n}) capNames;
          fromBrain = f: if b == null then [ ] else f b;
          credentials = unique (fromBrain (b: b.credentials) ++ concatMap (c: c.credentials) cs);
        in
        {
          inherit name capNames credentials;
          # Null for an agent that works for the user directly and holds
          # nothing of a brain's.
          brain = t.brain or null;
          environments = t.environments or [ ];
          needs = unique (concatMap (c: c.needs) cs);
          memory = foldl' max (t.memory or 0) (map (c: c.memory) cs);
          cores = foldl' max (t.cores or 0) (map (c: c.cores) cs);
          disk = foldl' max (t.disk or 0) (map (c: c.disk) cs);
          # Started on demand in a slot, rather than a VM of its own.
          spawnable = t.spawnable or false;
          egress = unique (fromBrain (b: b.egress) ++ concatMap (c: c.egress) cs);
          # The approval rule: a template with no credentials runs whoever
          # asks; one with any needs the user's yes when a brain asks.
          needsApproval = credentials != [ ];
          # Where it can be built: every capability has to agree.
          targets = foldl' (acc: c: builtins.filter (k: elem k c.targets) acc) [ "vm" "oci" ] cs;
          # The template's own modules first (a guest's base: its machine,
          # its network), then the brain's, then each capability's.
          modules = (t.modules or [ ]) ++ fromBrain (b: b.modules) ++ concatMap (c: c.modules) cs;
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

      # A spawnable template on a slot: the slot's guest, then the template.
      # Named `<template>@<slot>`, which the slot's launcher builds.
      slotGuests = lib.concatMapAttrs
        (_: t: lib.mapAttrs'
          (slot: plan: lib.nameValuePair "${t.name}@${slot}" (checked (nixosSystem {
            modules = [ (import ./guest/slot.nix { inherit plan; template = t; }) ]
              ++ slotModules ++ t.modules ++ [ (guestCheck t) ];
          })))
          slots)
        (lib.filterAttrs (_: t: t.spawnable && runsAsVm t) resolved);
    in
    {
      templates = lib.mapAttrs (_: checked) resolved;
      environments = envs;
      inherit errors;

      nixosConfigurations = lib.mapAttrs
        (_: t: checked (nixosSystem { modules = t.modules ++ [ (guestCheck t) ]; }))
        (lib.filterAttrs (_: t: runsAsVm t && !t.spawnable) resolved)
      // slotGuests;

      # Every host a slot may need to reach: the union of the spawnable
      # templates' egress, for the slots' allowlist.
      slotEgress = unique (concatMap (t: t.egress) (lib.attrValues (lib.filterAttrs (_: t: t.spawnable) resolved)));
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
  };
in
{
  inherit mkFleet capabilities;
}
