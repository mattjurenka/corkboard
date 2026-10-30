// This machine as the fleet view's card for it shows it: what it is and how
// busy. The bridge describes its own machine; fleetd, the one it runs on.

import { readFileSync } from "node:fs";
import { cpus, hostname, loadavg, release, totalmem, uptime } from "node:os";

export type Host = {
  name: string;
  os?: string;
  kernel: string;
  cpu?: string;
  cores: number;
  // MiB.
  memory: number;
  available?: number;
  load: number[];
  // Seconds.
  uptime: number;
};

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

export function host(): Host {
  const available = Number(read("/proc/meminfo").match(/^MemAvailable:\s+(\d+) kB/m)?.[1]);
  return {
    name: hostname(),
    os: read("/etc/os-release").match(/^PRETTY_NAME="?([^"\n]*)/m)?.[1],
    kernel: release(),
    cpu: cpus()[0]?.model.trim(),
    cores: cpus().length,
    memory: Math.round(totalmem() / 1048576),
    available: Number.isFinite(available) ? Math.round(available / 1024) : undefined,
    load: loadavg().map((n) => Math.round(n * 100) / 100),
    uptime: Math.round(uptime()),
  };
}

// What changes from one look to the next on its own, left out when asking
// whether anything did.
export const steady = (h: Host | undefined) => h && { ...h, available: undefined, load: undefined, uptime: undefined };
