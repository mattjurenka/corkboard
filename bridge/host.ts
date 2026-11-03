// This machine as the fleet view's card for it shows it: what it is and how
// busy. The bridge describes its own machine; fleetd, the one it runs on.

import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
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
  // Each disk's filesystem (MiB), and how hard it's all worked since the
  // last look: cpu as a fraction busy, the rest bytes a second. mem is the
  // memory controller's traffic, where the CPU counts it (resctrl).
  disks?: { mount: string; size: number; used: number }[];
  rates?: { cpu: number; mem?: number; read: number; write: number; rx: number; tx: number };
  // The most each rate could be, in bytes a second, each way: what the
  // hardware says it can do, or (named in peak) the most it's done yet.
  limits?: { mem?: number; io: number; net: number };
  peak?: ("mem" | "io" | "net")[];
};

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const lines = (path: string) => read(path).split("\n").filter(Boolean);

// The filesystems on real disks, one per device: a btrfs subvolume or bind
// mount is the same space again.
function disks() {
  const seen = new Set<string>();
  const out: NonNullable<Host["disks"]> = [];
  for (const line of lines("/proc/mounts")) {
    const [dev, mount] = line.split(" ");
    if (!dev.startsWith("/dev/") || dev.startsWith("/dev/loop") || seen.has(dev)) continue;
    seen.add(dev);
    try {
      const s = statfsSync(mount.replace(/\\040/g, " "));
      const size = Math.round((s.blocks * s.bsize) / 1048576);
      if (size > 0) out.push({ mount, size, used: Math.round(((s.blocks - s.bfree) * s.bsize) / 1048576) });
    } catch {}
  }
  return out.sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, 8);
}

// What the hardware says it can move, bytes a second: the memory, as
// fleet/host/counters.nix found at boot; the physical disks, by their PCIe
// links (a SATA or virtio disk says nothing); the physical network cards,
// by their link speed (Wi-Fi says nothing).
function capacity() {
  const mem = Number(read("/run/corkboard/memory-bandwidth").trim() || NaN);
  let io = 0;
  for (const dev of lines("/proc/diskstats").map((l) => l.trim().split(/\s+/)[2])) {
    const link = `/sys/block/${dev}/device/device`;
    const gts = parseFloat(read(`${link}/current_link_speed`));
    const width = Number(read(`${link}/current_link_width`).trim() || NaN);
    // From PCIe 3 on, 128 bits in 130; before, 8 in 10.
    if (gts > 0 && width > 0) io += (gts * 1e9 * width * (gts >= 8 ? 128 / 130 : 0.8)) / 8;
  }
  let net = 0;
  try {
    for (const name of readdirSync("/sys/class/net")) {
      if (!existsSync(`/sys/class/net/${name}/device`)) continue;
      const mbps = Number(read(`/sys/class/net/${name}/speed`).trim() || NaN);
      if (mbps > 0) net += mbps * 125000;
    }
  } catch {}
  return { mem: Number.isFinite(mem) && mem > 0 ? mem : 0, io: Math.round(io), net };
}

// Counters that only go up, read now: cpu jiffies (busy and all), bytes
// read and written on the physical disks and through the physical network
// cards (not a VM's tap, nor a dm or loop over a disk already counted), and
// the memory controller's, if resctrl is mounted.
function counters() {
  const cpu = lines("/proc/stat")[0]?.split(/\s+/).slice(1).map(Number) ?? [];
  const all = cpu.reduce((a, b) => a + b, 0);
  // Less idle and iowait.
  const busy = all - (cpu[3] ?? 0) - (cpu[4] ?? 0);
  let readBytes = 0, writeBytes = 0;
  for (const line of lines("/proc/diskstats")) {
    const f = line.trim().split(/\s+/);
    if (!existsSync(`/sys/block/${f[2]}/device`)) continue;
    readBytes += Number(f[5]) * 512;
    writeBytes += Number(f[9]) * 512;
  }
  let rx = 0, tx = 0;
  for (const line of lines("/proc/net/dev").slice(2)) {
    const [name, rest] = line.split(":");
    if (!existsSync(`/sys/class/net/${name.trim()}/device`)) continue;
    const f = rest.trim().split(/\s+/);
    rx += Number(f[0]);
    tx += Number(f[8]);
  }
  let mem: number | undefined;
  try {
    for (const domain of readdirSync("/sys/fs/resctrl/mon_data")) {
      const n = Number(read(`/sys/fs/resctrl/mon_data/${domain}/mbm_total_bytes`).trim() || NaN);
      if (Number.isFinite(n)) mem = (mem ?? 0) + n;
    }
  } catch {}
  return { at: Date.now(), busy, all, read: readBytes, write: writeBytes, rx, tx, mem };
}

// The rates between the last look and this one; a look sooner than a
// second after keeps the last rates.
let last: ReturnType<typeof counters> | undefined;
let rates: Host["rates"];
// The most each way yet, for a rate the hardware gives no limit for.
const most = { mem: 0, io: 0, net: 0 };
function measure() {
  const now = counters();
  if (last && now.at - last.at < 1000) return rates;
  if (last) {
    const secs = (now.at - last.at) / 1000;
    const per = (a: number, b: number) => Math.max(0, Math.round((a - b) / secs));
    rates = {
      cpu: now.all > last.all ? Math.round(((now.busy - last.busy) / (now.all - last.all)) * 1000) / 1000 : 0,
      ...(now.mem !== undefined && last.mem !== undefined && { mem: per(now.mem, last.mem) }),
      read: per(now.read, last.read),
      write: per(now.write, last.write),
      rx: per(now.rx, last.rx),
      tx: per(now.tx, last.tx),
    };
    most.mem = Math.max(most.mem, rates.mem ?? 0);
    most.io = Math.max(most.io, rates.read, rates.write);
    most.net = Math.max(most.net, rates.rx, rates.tx);
  }
  last = now;
  return rates;
}
// From the start, so the first look has rates.
measure();

function limits(): Pick<Host, "limits" | "peak"> {
  if (!rates) return {};
  const hw = capacity();
  const peak = (["mem", "io", "net"] as const).filter((k) => !hw[k] && (k !== "mem" || rates!.mem !== undefined));
  const pick = (k: "mem" | "io" | "net") => hw[k] || most[k];
  return { limits: { ...(rates.mem !== undefined && { mem: pick("mem") }), io: pick("io"), net: pick("net") }, ...(peak.length && { peak }) };
}

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
    disks: disks(),
    rates: measure(),
    ...limits(),
  };
}

// What changes from one look to the next on its own, left out when asking
// whether anything did.
export const steady = (h: Host | undefined) =>
  h && { ...h, available: undefined, load: undefined, uptime: undefined, rates: undefined, limits: undefined, peak: undefined, disks: h.disks?.map((d) => ({ ...d, used: undefined })) };
