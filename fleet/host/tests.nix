# `nix flake check`: what host.nix makes of a sample host, evaluated as a
# NixOS system and never booted. Three VMs: a slot on an allowlist, a
# resident on an allowlist with a routed hole, and an open one. What's read
# by evaluation (the manifest, the resolver, the firewall, the assertions)
# is checked here, so a failure is an evaluation error naming it; the
# generated ruleset and proxy config are files, so the derivation reads
# them, and has nftables check the ruleset.
{ pkgs, lib, nixosSystem, fleetHost }:
let
  plan = import ../plan.nix;
  plans = {
    agent-0 = plan { name = "agent-0"; interface = "ag0"; octet = 90; mac = "52:54:00:c1:a0:90"; };
    brain = plan { name = "brain"; interface = "br0"; octet = 91; mac = "52:54:00:c1:a0:91"; };
    web = plan { name = "web"; interface = "wb0"; octet = 92; mac = "52:54:00:c1:a0:92"; };
  };

  steam = {
    reason = "Steam's game traffic.\nUDP, which the proxy can't carry.";
    destinations = [ "155.133.224.0/19" "162.254.192.0/21" ];
    udpPorts = [ "27015-27050" ];
    resolveDomains = [ "steamserver.net" ];
  };

  instances = {
    agent-0 = { slot = true; egress = "allowlist"; allowedDomains = [ "api.anthropic.com" "github.com" ]; allowedDomainSuffixes = [ "githubusercontent.com" ]; memoryMax = 6144; };
    brain = { headless = true; egress = "allowlist"; allowedDomains = [ "api.anthropic.com" ]; routedEgress = [ steam ]; memoryMax = 8192; };
    web = { egress = "open"; };
  };

  eval = agentVms: (nixosSystem {
    modules = [
      fleetHost
      {
        nixpkgs.hostPlatform = pkgs.stdenv.hostPlatform.system;
        boot.isContainer = true;
        system.stateVersion = "25.05";
        my.agentVms = { inherit plans; owner = "tester"; } // agentVms;
      }
    ];
  }).config;

  good = eval {
    inherit instances;
    memoryBudget = 16384;
    offer.memory = 4096;
    defaultAccount = "personal";
    templates.coding = { spawnable = true; memory = 2048; cores = 2; needsApproval = false; capNames = [ "coding" ]; credentials = [ ]; };
  };

  # The messages of host.nix's assertions that fail.
  failing = c: map (a: lib.trim a.message) (lib.filter (a: !a.assertion && lib.hasPrefix "my.agentVms:" (lib.trim a.message)) c.assertions);
  failsWith = text: agentVms: lib.any (lib.hasInfix text) (failing (eval agentVms));
  # The good instances, with one changed.
  with' = name: inst: { instances = instances // { ${name} = instances.${name} // inst; }; };

  manifest = builtins.fromJSON good.environment.etc."corkboard/fleet.json".text;
  dns = good.services.dnsmasq;

  tests = {
    theSampleIsFine = failing good == [ ];

    # What fleetd reads: the slot, where it is and what it may reach.
    manifestHasTheSlot =
      builtins.attrNames manifest.slots == [ "agent-0" ]
      && manifest.slots.agent-0 == {
        guestAddress = "10.90.0.2"; hostAddress = "10.90.0.1"; unit = "agent-0.service";
        stateDir = "/var/lib/agent-0"; shareDir = "/var/lib/agent-0/share"; outboxDir = "/var/lib/agent-0/outbox";
        network = { address = "10.90.0.2"; egress = "allowlist"; allowedDomains = [ "api.anthropic.com" "github.com" ]; allowedDomainSuffixes = [ "githubusercontent.com" ]; routedEgress = [ ]; };
      };

    manifestHasTheResidentAndItsHole =
      builtins.attrNames manifest.residents == [ "brain" ]
      && manifest.residents.brain.memory == 8192
      && manifest.residents.brain.network.routedEgress == [ { inherit (steam) reason destinations udpPorts; tcpPorts = [ ]; } ];

    manifestHasTheSpawnableTemplates =
      manifest.templates == { coding = { memory = 2048; cores = 2; needsApproval = false; capNames = [ "coding" ]; credentials = [ ]; git = null; agent = "claude"; }; }
      && manifest.memoryBudget == 16384 && manifest.offer.memory == 4096 && manifest.defaultAccount == "personal"
      && !(manifest ? node);

    # Only the slot is the owner's to start and stop.
    polkitNamesOnlyTheSlot = lib.hasInfix ''var slots = ["agent-0.service"];'' good.security.polkit.extraConfig;

    fleetdRunsAsTheOwner = good.systemd.user.services.corkboard-fleetd.unitConfig.ConditionUser == "tester";

    # The resolver answers the routed hole's domains, upstream, and nothing else.
    resolverOnlyForTheRoutedHole =
      dns.enable && !dns.resolveLocalQueries
      && dns.settings.interface == [ "br0" ] && dns.settings.listen-address == [ "10.91.0.1" ]
      && dns.settings.no-resolv == [ true ] && dns.settings.no-hosts == [ true ]
      && dns.settings.server == [ "/steamserver.net/1.1.1.1" "/steamserver.net/1.0.0.1" ];

    noResolverWithoutAHole = !(eval (with' "brain" { routedEgress = [ ]; })).services.dnsmasq.enable;

    # NixOS's firewall, at the hook after the VM's own table, lets an
    # allowlisted guest reach its proxy (and the resolver, with a hole), a
    # slot's its forge, and an open one nothing on the host.
    firewallOpensOnlyTheHoles =
      let ports = i: lib.mapAttrs (_: lib.sort lib.lessThan) { inherit (good.networking.firewall.interfaces.${i}) allowedTCPPorts allowedUDPPorts; }; in
      ports "ag0" == { allowedTCPPorts = [ 8888 8890 ]; allowedUDPPorts = [ ]; }
      && ports "br0" == { allowedTCPPorts = [ 53 8888 ]; allowedUDPPorts = [ 53 ]; }
      && !(good.networking.firewall.interfaces ? wb0);

    anOpenSlotStillReachesItsForge =
      (eval (with' "agent-0" { egress = "open"; allowedDomains = [ ]; allowedDomainSuffixes = [ ]; })).networking.firewall.interfaces.ag0.allowedTCPPorts == [ 8890 ];

    aProxyForEachAllowlistedVm =
      lib.all (n: good.systemd.services ? "${n}-proxy") [ "agent-0" "brain" ]
      && !(good.systemd.services ? web-proxy)
      && good.systemd.services.agent-0-proxy.serviceConfig.User == "tinyproxy";

    # A slot runs once; a resident comes back.
    slotsRunOnce =
      good.systemd.services.agent-0.serviceConfig.Restart == "no"
      && good.systemd.services.agent-0.wantedBy == [ ]
      && good.systemd.services.brain.serviceConfig.Restart == "on-failure"
      && good.systemd.services.brain.serviceConfig.MemoryMax == "8192M"
      && good.systemd.services.brain.serviceConfig.MemoryHigh == "7168M";

    # An instance with no plan is no VM.
    unplannedIsIgnored = !((eval { instances = instances // { ghost = { headless = true; }; }; }).systemd.services ? ghost);

    allowlistOfNothing = failsWith "can reach nothing at all" (with' "agent-0" { allowedDomains = [ ]; allowedDomainSuffixes = [ ]; });

    routedOnOpen = failsWith "routedEgress only means something" (with' "web" { routedEgress = [ steam ]; });

    halfAHoleNoPorts = failsWith "needs both `destinations`" (with' "brain" { routedEgress = [ (steam // { udpPorts = [ ]; }) ]; });

    halfAHoleNoDestinations = failsWith "needs both `destinations`" (with' "brain" { routedEgress = [ (steam // { destinations = [ ]; }) ]; });

    privateHoles = lib.all
      (d: failsWith "private or" (with' "brain" { routedEgress = [ (steam // { destinations = [ d ]; }) ]; }))
      [ "10.0.0.0/8" "127.0.0.1/32" "169.254.0.0/16" "192.168.1.0/24" "172.16.0.0/12" "172.31.0.0/16" "100.64.0.0/10" "100.127.0.0/16" ];

    # The private test is by prefix: neighbours of the private ranges are public.
    publicNeighboursAreFine = lib.all
      (d: failing (eval (with' "brain" { routedEgress = [ (steam // { destinations = [ d ]; }) ]; })) == [ ])
      [ "172.32.0.0/16" "172.15.0.0/16" "100.128.0.0/10" "100.63.0.0/16" "11.0.0.0/8" ];

    # The resolver is one dnsmasq, so one instance may have a hole.
    twoRoutedInstances = failsWith "routedEgress on more than one instance (agent-0, brain)" (with' "agent-0" { routedEgress = [ steam ]; });

    slotSmallerThanTheOffer = failsWith "every\nslot's memoryMax needs to be at least 5632" (with' "agent-0" { memoryMax = 4096; } // { offer.memory = 4096; });

    slotWithNoCeilingIsFine = failing (eval (with' "agent-0" { memoryMax = null; } // { offer.memory = 4096; })) == [ ];
  };

  failed = builtins.attrNames (lib.filterAttrs (_: ok: !ok) tests);

  # The files: the units name them, so they're built for this.
  net = n: pkgs.writeText "${n}-net" good.systemd.services."${n}-net".script;
  proxy = n: pkgs.writeText "${n}-proxy" good.systemd.services."${n}-proxy".serviceConfig.ExecStart;
in
if failed != [ ] then throw "fleet host tests failed: ${lib.concatStringsSep ", " failed}"
else pkgs.runCommand "fleet-host-tests" { nativeBuildInputs = [ pkgs.gnugrep pkgs.nftables ]; } ''
  fail() { echo "fleet host: $*" >&2; exit 1; }
  file() { grep -o '/nix/store/[^ "]*'"$2" "$1" | head -1; }
  has() { grep -qF -- "$2" "$1" || fail "$1 has no: $2"; }
  hasnt() { ! grep -qF -- "$2" "$1" || fail "$1 has: $2"; }

  # The rulesets.
  slot=$(file ${net "agent-0"} .nft); brain=$(file ${net "brain"} .nft); web=$(file ${net "web"} .nft)
  # The proxy, the forge, and nothing else in, for the slot; no route out.
  has $slot 'iifname "ag0" tcp dport 8888 counter accept'
  has $slot 'iifname "ag0" tcp dport 8890 counter accept'
  hasnt $slot 'dport 53'
  has $slot 'iifname "ag0" counter drop'
  # Nothing in but replies: no other guest or machine reaches the slot's
  # ports (the browser's forwarded DevTools among them), only the host.
  has $slot 'oifname "ag0" ct state established,related counter accept'
  has $slot 'oifname "ag0" counter drop'
  hasnt $slot 'masquerade'
  # The resident's hole: its reason as comments, destinations and ports in one rule, NAT, DNS.
  has $brain "# Steam's game traffic."
  has $brain "# UDP, which the proxy can't carry."
  tr -s ' \n' ' ' < $brain > brain.flat
  has brain.flat 'iifname "br0" ip daddr { 155.133.224.0/19, 162.254.192.0/21 } udp dport 27015-27050 counter accept'
  hasnt $brain 'tcp dport 27015'
  has $brain 'iifname "br0" udp dport 53 counter accept'
  has $brain 'ip saddr 10.91.0.0/24 oifname != "br0" counter masquerade'
  hasnt $brain 'tcp dport 8890'
  # The open one: the public internet, nothing private, no proxy.
  tr -s ' \n' ' ' < $web > web.flat
  has web.flat 'iifname "wb0" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } counter drop'
  has $web 'iifname "wb0" counter accept'
  hasnt $web 'dport 8888'
  has $web 'ip saddr 10.92.0.0/24 oifname != "wb0" counter masquerade'

  # nftables' own check, on a kernel in userspace as NixOS's checkRuleset
  # has it: a ruleset the kernel refuses fails here, not at boot.
  export NIX_REDIRECTS=/etc/protocols=${pkgs.iana-etc}/etc/protocols:/etc/services=${pkgs.iana-etc}/etc/services
  for f in $slot $brain $web; do
    LD_PRELOAD="${pkgs.libredirect}/lib/libredirect.so ${pkgs.lklWithFirewall.lib}/lib/liblkl-hijack.so" \
      nft --check --file $f || fail "$f is refused"
  done

  # The slot's proxy: on its gateway, for its guest, deny by default, 443 only.
  conf=$(file ${proxy "agent-0"} -proxy.conf)
  has $conf 'Listen 10.90.0.1'
  has $conf 'Allow 10.90.0.2'
  has $conf 'Port 8888'
  has $conf 'FilterDefaultDeny yes'
  has $conf 'ConnectPort 443'
  filter=$(file $conf .filter)
  [ "$(cat $filter)" = "$(printf '%s\n' '^api\.anthropic\.com$' '^github\.com$' '^([A-Za-z0-9_-]+\.)*githubusercontent\.com$')" ] || { cat $filter; fail "the slot's filter"; }
  echo ${toString (builtins.length (builtins.attrNames tests))} evaluated, and the files > $out
''
