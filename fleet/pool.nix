# A pool of slots for spawned agents: `size` plans, `<name>-0` up, each
# with its own tap, /24 and MAC, so a host can run that many at once. Which
# of them a spawn gets is fleetd's business, and none is anyone's in
# particular; what bounds how many run is the memory budget.
{ size, name ? "slot", interface ? "fslot", octet ? 100, mac ? "52:54:00:c1:b0" }:
assert size >= 1 && size <= 64 && octet + size <= 255;
let
  digits = [ "0" "1" "2" "3" "4" "5" "6" "7" "8" "9" "a" "b" "c" "d" "e" "f" ];
  hex = i: builtins.elemAt digits (i / 16) + builtins.elemAt digits (i - i / 16 * 16);
in
builtins.listToAttrs (builtins.genList
  (i: {
    name = "${name}-${toString i}";
    value = import ./plan.nix {
      name = "${name}-${toString i}";
      interface = "${interface}${toString i}";
      octet = octet + i;
      mac = "${mac}:${hex i}";
    };
  })
  size)
