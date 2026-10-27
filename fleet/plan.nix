# The address plan and paths for one agent VM, shared between the host-side
# plumbing in ./host/host.nix and the guests, so the two can never drift
# apart.
#
# Each VM gets its own /24, its own tap device and its own nftables table, so
# two VMs can run at once without their rules interacting. The installing
# flake makes one plan per VM with this, hands the set to the host as
# `my.agentVms.plans`, and gives each guest its own.
#
# Moved here from ~/nixosconfig/modules/features/agent-vm/plan.nix on
# 2026-10-27; the instances stayed there.
{
  # Matches the nixosConfigurations name and the guest's hostName: the
  # launcher derives `run-<name>-vm` from it.
  name,
  # Kernel interface names are capped at 15 characters, so these are
  # abbreviated rather than derived from `name`.
  interface,
  # Second octet of the VM's /24. Must be unique per VM.
  octet,
  mac,
  # Port the host-side filtering proxy listens on, for VMs whose egress
  # is an allowlist. Unused when egress is open.
  proxyPort ? 8888,
  # How many independent interactive consoles the guest offers.
  #
  # One is not a limitation of the socket but of two things at once, and
  # raising this is the only way around either. QEMU's `socket` chardev
  # serves exactly one client at a time -- there is a `mux` option but it
  # multiplexes QEMU *frontends* onto one backend (monitor plus serial),
  # not clients onto one socket -- so a second `UNIX-CONNECT` sits in the
  # accept backlog until the first detaches. And even if it could connect,
  # there is one `/dev/hvc0` with one `bash -i` on it, so both clients
  # would share a single shell and a single terminal state, which is
  # garbled output rather than a second session.
  #
  # So each console is a genuinely separate thing all the way down: its
  # own virtio-serial port, its own unix socket on the host, and its own
  # shell service in the guest. Ports are cheap -- one virtio-serial-pci
  # bus carries 31 of them -- and an idle console costs a socket file and
  # a blocked `bash`.
  consoles ? 1,
}:
assert consoles >= 1;
rec {
  inherit name interface mac proxyPort consoles;

  prefixLength = 24;
  hostAddress = "10.${toString octet}.0.1";
  guestAddress = "10.${toString octet}.0.2";
  subnet = "10.${toString octet}.0.0/${toString prefixLength}";

  stateDir = "/var/lib/${name}";
  shareDir = "${stateDir}/share";
  # The way back out. `shareDir` is read-only in the guest so a file
  # handed in cannot be altered or deleted by the agent -- which also
  # leaves the agent no way to hand anything back. This one is
  # writable and carries traffic in that direction only. Created for
  # every instance, so a guest that wants it need only declare the
  # share.
  outboxDir = "${stateDir}/outbox";
  diskImage = "${stateDir}/disk.qcow2";
  spiceSocket = "${stateDir}/spice.sock";
  runDir = "${stateDir}/run";

  # A headless VM's stdio console goes to the journal, which is
  # write-only: there is no way to type into it. These ports are the way
  # in -- unix sockets, so QEMU-level rather than network, reachable only
  # by whoever can open the file, and unusable by the guest to reach
  # anything.
  #
  # Indices are 1-based because they are user-facing: `brain-vm-console 2`
  # is the second console. The guest's device numbering is 0-based
  # (hvc0..hvcN-1), so the two are deliberately converted in one place --
  # `consoleDevice` below -- rather than at each use.
  consoleIndices = builtins.genList (i: i + 1) consoles;

  # Console 1 keeps the original unsuffixed path. Renaming it would have
  # been tidier, but the socket is also what a running VM is already
  # serving and what muscle memory and any stray script point at.
  consoleSocketFor = i:
    if i == 1 then "${stateDir}/console.sock"
    else "${stateDir}/console-${toString i}.sock";
  consoleSockets = map consoleSocketFor consoleIndices;

  # Held by the host-side wrapper for as long as it is attached, so a
  # second invocation can find a free console instead of silently
  # blocking on a busy socket. A lock rather than probing the socket:
  # connecting to a busy chardev is exactly the thing being avoided, so
  # it cannot also be the test for it.
  consoleLockFor = i: "${stateDir}/console-${toString i}.lock";

  consoleDevice = i: "hvc${toString (i - 1)}";
  consoleChardevId = i: "${name}console${toString i}";

  # The first console, for the callers that only ever want one.
  consoleSocket = consoleSocketFor 1;
}
