# `nix flake check`: the fleet's resolution and placement rules, on a small
# fleet of their own. Each test is evaluated here, so a failure is an
# evaluation error naming it; the derivation only exists if all pass.
{ pkgs, lib }:
let
  inherit (import ./lib.nix { inherit lib; }) mkFleet;

  base = {
    bindings = {
      pepper = { };
      work.shares.vault = { source = "/home/me/vault"; target = "/mnt/vault"; writable = true; };
    };
    egress = [ "api.anthropic.com" ];
    capabilities = {
      coding = { memory = 4096; cores = 2; egress = [ "github.com" ]; targets = [ "vm" "oci" ]; };
      mail = { egress = [ "gmail.googleapis.com" ]; credentials = [ "google" ]; targets = [ "vm" "oci" ]; };
      display = { needs = [ "display" ]; };
      screenshot = { requires = [ "display" ]; };
      valheim = { memory = 16384; cores = 6; needs = [ "gpu" ]; requires = [ "screenshot" ]; };
    };
    environments = {
      local = { kind = "vm"; provides = [ "gpu" "display" "kvm" ]; };
      cloud = { kind = "oci"; };
    };
  };

  fleet = templates: mkFleet (base // { inherit templates; });

  fails = x: !(builtins.tryEval (builtins.deepSeq x x)).success;

  tests = {
    requiresAreFollowed =
      (fleet { v = { capabilities = [ "valheim" ]; environments = [ "local" ]; }; }).templates.v.capNames
      == [ "valheim" "screenshot" "display" ];

    needsAreUnioned =
      (fleet { v = { capabilities = [ "valheim" ]; environments = [ "local" ]; }; }).templates.v.needs
      == [ "gpu" "display" ];

    sizesTakeTheLargest =
      let t = (fleet { v = { capabilities = [ "coding" "valheim" ]; environments = [ "local" ]; memory = 2048; }; }).templates.v;
      in t.memory == 16384 && t.cores == 6;

    egressMergesCapabilities =
      (fleet { p = { capabilities = [ "coding" "mail" ]; environments = [ "cloud" ]; }; }).templates.p.egress
      == [ "github.com" "gmail.googleapis.com" ];

    modulesAreTemplateThenCapabilities =
      let
        f = mkFleet (lib.recursiveUpdate base {
          capabilities.display.modules = [ "display" ];
          capabilities.screenshot.modules = [ "screenshot" ];
          templates.p = { modules = [ "base" ]; capabilities = [ "screenshot" ]; environments = [ "local" ]; };
        });
      in
      f.templates.p.modules == [ "base" "screenshot" "display" ];

    noCredentialsNoApproval =
      !(fleet { c = { capabilities = [ "coding" ]; environments = [ "cloud" ]; }; }).templates.c.needsApproval;

    capabilityCredentialsNeedApproval =
      (fleet { p = { capabilities = [ "coding" "mail" ]; environments = [ "cloud" ]; }; }).templates.p.needsApproval;

    # A brain is a spawn's, never a template's.
    aTemplateWithABrainIsAnError =
      fails (fleet { p = { brain = "pepper"; capabilities = [ "coding" ]; environments = [ "local" ]; }; }).templates.p;

    missingNeedIsAnError =
      let f = fleet { v = { capabilities = [ "valheim" ]; environments = [ "cloud" ]; }; }; in
      fails f.templates.v
      && f.errors == [
        "v on cloud: needs gpu, display; cloud provides none"
        "v on cloud: cloud runs oci agents; valheim, screenshot, display cannot be built as oci"
      ];

    unknownEnvironmentIsAnError =
      fails (fleet { c = { capabilities = [ "coding" ]; environments = [ "moon" ]; }; }).templates.c;

    unknownCapabilityIsAnError =
      fails (fleet { c = { capabilities = [ "sorcery" ]; environments = [ "local" ]; }; }).templates.c;

    # One bad template poisons the fleet, so it can't be missed by evaluating
    # only the good ones.
    oneBadTemplateFailsAll =
      fails (fleet {
        good = { capabilities = [ "coding" ]; environments = [ "local" ]; };
        bad = { capabilities = [ "valheim" ]; environments = [ "cloud" ]; };
      }).templates.good;

    # A spawnable template is a slot guest, `<template>@slot`, that boots in
    # any slot, and one more for each brain with memory bound here,
    # `<template>+<brain>@slot`; not a guest of its own.
    spawnableTemplatesGetSlotGuests =
      builtins.attrNames (mkFleet (base // {
        nixosSystem = args: args;
        templates = {
          c = { capabilities = [ "coding" ]; environments = [ "local" ]; spawnable = true; };
          resident = { capabilities = [ "coding" ]; environments = [ "local" ]; };
        };
      })).nixosConfigurations == [ "c+work@slot" "c@slot" "resident" ];

    slotEgressIsEverySpawnableTemplatesAndTheBrains =
      (mkFleet (base // {
        templates = {
          c = { capabilities = [ "coding" ]; environments = [ "local" ]; spawnable = true; };
          notSpawned = { capabilities = [ "mail" ]; environments = [ "local" ]; };
        };
      })).slotEgress == [ "portal.corkboard.fyi" "github.com" "api.anthropic.com" ];

    bindingsListTheirShares =
      (fleet { }).bindings == { pepper.shares = [ ]; work.shares = [ "vault" ]; };

    onlyVmTemplatesGetGuests =
      builtins.attrNames (fleet {
        here = { capabilities = [ "coding" ]; environments = [ "local" ]; };
        there = { capabilities = [ "coding" ]; environments = [ "cloud" ]; };
      }).nixosConfigurations == [ "here" ];
  };

  failed = builtins.attrNames (lib.filterAttrs (_: ok: !ok) tests);
in
if failed != [ ] then throw "fleet tests failed: ${lib.concatStringsSep ", " failed}"
else pkgs.runCommand "fleet-tests" { } ''
  echo ${toString (builtins.length (builtins.attrNames tests))} fleet tests passed > $out
''
