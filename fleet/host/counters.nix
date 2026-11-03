# What the fleet view's resources need root for, set up at boot for
# bridge/host.ts (which runs as the user): the memory controller's traffic,
# where the CPU counts it (resctrl, whose mon_data anyone may read), and the
# most the memory can move, from the DIMMs' speed and width (SMBIOS type 17,
# which only root may read) into /run/corkboard/memory-bandwidth, in bytes a
# second. A machine with neither has neither; nothing fails.
{ pkgs, ... }:
{
  systemd.services.corkboard-counters = {
    wantedBy = [ "multi-user.target" ];
    path = [ pkgs.util-linux pkgs.coreutils ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      mountpoint -q /sys/fs/resctrl || mount -t resctrl resctrl /sys/fs/resctrl || true
      # Where counters are assigned to groups (AMD's ABMC), the root group's
      # can read a constant on some parts (a Ryzen AI 7 445); the default
      # mode counts every group's.
      mode=/sys/fs/resctrl/info/L3_MON/mbm_assign_mode
      [ -w "$mode" ] && grep -q default "$mode" && echo default > "$mode" || true

      # A field of a type 17 entry: its offset and size (bytes), little-endian.
      field() { echo $(( $(od -An -tu"$3" -j"$2" -N"$3" "$1") )); }
      total=0
      for f in /sys/firmware/dmi/entries/17-*/raw; do
        [ -r "$f" ] || continue
        len=$(field "$f" 1 1)
        size=$(field "$f" 12 2)
        width=$(field "$f" 10 2)
        # An empty slot, or a width the firmware doesn't know.
        if (( size == 0 || width == 0 || width == 65535 )); then continue; fi
        speed=$(field "$f" 21 2)
        (( speed == 65535 && len >= 0x58 )) && speed=$(field "$f" 84 4)
        configured=0
        (( len >= 0x22 )) && configured=$(field "$f" 32 2)
        (( configured == 65535 && len >= 0x5c )) && configured=$(field "$f" 88 4)
        (( configured > 0 && configured != 65535 )) && speed=$configured
        total=$(( total + speed * 1000000 * width / 8 ))
      done
      mkdir -p /run/corkboard
      if (( total > 0 )); then echo "$total" > /run/corkboard/memory-bandwidth; fi
    '';
  };
}
