// What fleetd and corkboard-fleet share: the host's manifest (written by
// fleet/host as /etc/corkboard/fleet.json), the spawns on disk, and the
// one decision that matters, which queued spawns start now.
//
// A spawn is a file, ~/.local/state/corkboard/fleet/spawns/<id>.json, and
// what its agent handed back is the directory of the same name. The CLI
// writes queued spawns, and so does fleetd for those it claims from the
// Worker's queue (queue.ts); fleetd is the only thing that moves them on.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where a VM is and what it may reach, as host.nix configures it.
export type Network = {
  address: string | null;
  egress: "open" | "allowlist";
  allowedDomains: string[];
  allowedDomainSuffixes: string[];
  routedEgress: { reason: string; destinations: string[]; tcpPorts: string[]; udpPorts: string[] }[];
};

export type Manifest = {
  flake: string;
  owner: string;
  // MiB the agents may have between them, or null for no limit.
  memoryBudget: number | null;
  // The most one spawn's VM may ask for (MiB, vCPUs), or null for no more
  // than the budget (and the host's cores).
  offer?: { memory: number | null; cores: number | null };
  slots: Record<string, { guestAddress: string; stateDir: string; shareDir: string; outboxDir: string; unit: string; network?: Network }>;
  // VMs that are always there: they count against the budget while up.
  residents: Record<
    string,
    { unit: string; memory: number | null; brain?: string | null; account?: string | null; cores?: number | null; capNames?: string[]; network?: Network }
  >;
  templates: Record<string, { memory: number; cores: number; needsApproval: boolean; capNames: string[]; credentials?: string[] }>;
  // The brains whose memory this host has, by name: the shares a spawn for
  // one mounts, in the guest `<template>+<brain>`. A brain with none runs
  // here in its template's own guest. Absent from a manifest written before
  // brains were spawns'.
  bindings?: Record<string, { shares: string[] }>;
  // The account a spawn runs as when nothing says.
  defaultAccount: string | null;
};

export type State = "queued" | "running" | "done" | "failed" | "stopped";

export type Spawn = {
  id: string;
  template: string;
  task: string;
  // A repo on this machine to work in; its commits come back as a bundle.
  repo?: string;
  // Who asked: "user", or a brain. A brain's spawn that holds credentials
  // waited for approval in the Worker's queue; the CLI's never does.
  by: string;
  // Who it works for, if a brain: its token goes in the share, and its
  // memory's with it if this host binds the brain.
  brain?: string;
  // The Claude account it runs as (accountFor), whose token it is handed.
  account: string;
  state: State;
  created: string;
  slot?: string;
  started?: string;
  ended?: string;
  exit?: number;
  error?: string;
  stopRequested?: boolean;
  // From the Worker's queue: its card, the spawn token for it, and its
  // brain's token if it has one (each emptied once it's revoked, at the end),
  // and the secrets of what it holds (dropped then too).
  remote?: { board: string; card: string; agent: string; token: string; brainToken?: string; secrets?: Record<string, string> };
  // A session you talk to rather than a task (sessions.ts); when it was
  // asked to finish, if it has been.
  interactive?: boolean;
  ending?: string;
  // The last state the Worker was told of.
  reported?: State;
  // The branch its commits were fetched into, in its repo.
  fetched?: string;
  // What the spawner brought: the tools the guest builds itself (a nixpkgs
  // package list, or a flake's devShell), and the VM's size if not the
  // template's. The host never evaluates the shell; see fleet/guest/slot.nix.
  shell?: { packages: string[] } | { flake: string };
  memory?: number;
  cores?: number;
  // A job of the Worker's that the guest runs instead of an agent:
  // "consolidate", a brain's consolidator (fleet/guest/slot.nix).
  job?: "consolidate";
};

// The MiB a spawn's VM is given, and what it costs the budget.
export const memoryOf = (m: Manifest, s: Spawn) => s.memory ?? m.templates[s.template]?.memory ?? 0;
export const coresOf = (m: Manifest, s: Spawn) => s.cores ?? m.templates[s.template]?.cores ?? null;

export const MANIFEST = process.env.CORKBOARD_FLEET_MANIFEST ?? "/etc/corkboard/fleet.json";
export const STATE = process.env.CORKBOARD_FLEET_STATE ?? join(homedir(), ".local/state/corkboard/fleet");
export const SPAWNS = join(STATE, "spawns");
// One Claude Code OAuth token per account, from `claude setup-token`, at
// accounts/<name>. An agent is handed its account's.
export const ACCOUNTS = join(STATE, "accounts");
export const tokenFor = (account: string) => join(ACCOUNTS, account);

// QEMU's own allocations on top of the guest's RAM, per running slot.
export const OVERHEAD = 512;

export function manifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

export function spawns(): Spawn[] {
  mkdirSync(SPAWNS, { recursive: true });
  return readdirSync(SPAWNS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SPAWNS, f), "utf8")) as Spawn)
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

export function read(id: string): Spawn | undefined {
  try {
    return JSON.parse(readFileSync(join(SPAWNS, `${id}.json`), "utf8"));
  } catch {
    return undefined;
  }
}

// Written whole and renamed into place, so a reader never sees half a file.
export function write(s: Spawn) {
  mkdirSync(SPAWNS, { recursive: true });
  const path = join(SPAWNS, `${s.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

// What the agent answered, from Claude Code's JSON output.
export function answer(s: Spawn): string | undefined {
  const f = join(SPAWNS, s.id, "result.json");
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")).result;
  } catch {
    return readFileSync(f, "utf8");
  }
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export type Plan = {
  start: { id: string; slot: string }[];
  fail: { id: string; error: string }[];
  // Why the first spawn still queued is waiting, if one is.
  waiting?: { id: string; reason: string };
};

// What's up, as the Worker's fleet view shows it: each resident VM, each
// slot and the spawn in it, and the memory they take of the budget. A
// resident counts at its memoryMax while up, a slot at its template's
// memory and OVERHEAD. Each says how it's configured, when the manifest
// does: a slot as the template it's running.
export type Config = Network & { cores: number | null; capabilities: string[]; account: string | null; needsApproval?: boolean };
export type Occupancy = {
  budget: number | null;
  used: number;
  residents: { name: string; brain: string | null; memory: number | null; up: boolean; config?: Config }[];
  slots: { name: string; spawn: string | null; template: string | null; brain: string | null; memory: number | null; config?: Config }[];
};

export function occupancy(m: Manifest, all: Spawn[], active: Set<string>): Occupancy {
  const residents = Object.entries(m.residents).map(([name, r]) => ({
    name,
    brain: r.brain ?? null,
    memory: r.memory,
    up: active.has(r.unit),
    ...(r.network && { config: { ...r.network, cores: r.cores ?? null, capabilities: r.capNames ?? [], account: r.account ?? null } }),
  }));
  const slots = Object.entries(m.slots).map(([name, slot]) => {
    const s = all.find((x) => x.state === "running" && x.slot === name);
    const t = s && m.templates[s.template];
    const config: Config | undefined = slot.network && {
      ...slot.network,
      cores: s ? coresOf(m, s) : (t?.cores ?? null),
      capabilities: t?.capNames ?? [],
      account: s?.account ?? null,
      ...(t && { needsApproval: t.needsApproval }),
    };
    return { name, spawn: s?.id ?? null, template: s?.template ?? null, brain: s?.brain ?? null, memory: s ? memoryOf(m, s) + OVERHEAD : null, ...(config && { config }) };
  });
  // A running spawn whose slot left the manifest still takes its memory.
  const lost = all.filter((s) => s.state === "running" && !m.slots[s.slot!]);
  const used =
    residents.reduce((n, r) => n + (r.up ? r.memory ?? 0 : 0), 0) +
    slots.reduce((n, s) => n + (s.memory ?? 0), 0) +
    lost.reduce((n, s) => n + memoryOf(m, s) + OVERHEAD, 0);
  return { budget: m.memoryBudget, used, residents, slots };
}

// Which queued spawns to start, given what is running. In order: a spawn
// that doesn't fit waits, and so does everything behind it, so a big spawn
// is never starved by small ones.
export function schedule(m: Manifest, all: Spawn[], active: Set<string>): Plan {
  const plan: Plan = { start: [], fail: [] };
  const running = all.filter((s) => s.state === "running");
  let used = occupancy(m, all, active).used;
  const busy = new Set(running.map((s) => s.slot));
  const free = Object.keys(m.slots).filter((name) => !busy.has(name) && !active.has(m.slots[name].unit));

  for (const s of all.filter((s) => s.state === "queued")) {
    const t = m.templates[s.template];
    if (!t) {
      plan.fail.push({ id: s.id, error: `no spawnable template ${s.template} here` });
      continue;
    }
    const need = memoryOf(m, s) + OVERHEAD;
    const offer = m.offer;
    if (s.memory && offer?.memory && s.memory > offer.memory) {
      plan.fail.push({ id: s.id, error: `asks for ${s.memory} MiB; one VM here gets at most ${offer.memory}` });
      continue;
    }
    if (s.cores && offer?.cores && s.cores > offer.cores) {
      plan.fail.push({ id: s.id, error: `asks for ${s.cores} cores; one VM here gets at most ${offer.cores}` });
      continue;
    }
    if (s.shell && s.brain) {
      plan.fail.push({ id: s.id, error: `a shell of your own never goes beside the ${s.brain} brain's memory; spawn it for no brain` });
      continue;
    }
    if (m.memoryBudget !== null && need > m.memoryBudget) {
      plan.fail.push({ id: s.id, error: `${s.template} needs ${need} MiB; the budget is ${m.memoryBudget}` });
      continue;
    }
    if (m.memoryBudget !== null && used + need > m.memoryBudget) {
      plan.waiting = { id: s.id, reason: `needs ${need} MiB; ${m.memoryBudget - used} of ${m.memoryBudget} free` };
      break;
    }
    const slot = free.shift();
    if (!slot) {
      plan.waiting = { id: s.id, reason: "every slot is busy" };
      break;
    }
    plan.start.push({ id: s.id, slot });
    used += need;
  }
  return plan;
}

// The account a spawn runs as: what was asked for (the Worker stamps a
// brain's spawn with the brain's), or the host's default.
export function accountFor(m: Manifest, asked?: string | null): string {
  const account = asked ?? m.defaultAccount;
  if (!account) throw new Error(`which account? --account <name> (there is no default)`);
  // A file name under ACCOUNTS.
  if (!/^[\w-]+$/.test(account)) throw new Error(`no account ${account}`);
  return account;
}

// What every slot here may reach, for the Worker to place a brain's spawn
// by: open if they all are, else the hosts and suffixes every allowlisted
// one has. Unknown (undefined) while a slot doesn't say, or there are none.
export function egressOf(m: Manifest): { open: boolean; domains: string[]; suffixes: string[] } | undefined {
  const nets = Object.values(m.slots).map((s) => s.network);
  if (!nets.length || nets.some((n) => !n)) return undefined;
  const lists = nets.filter((n) => n!.egress === "allowlist") as Network[];
  if (!lists.length) return { open: true, domains: [], suffixes: [] };
  const every = (f: (n: Network) => string[]) => f(lists[0]).filter((d) => lists.every((n) => f(n).includes(d)));
  return { open: false, domains: every((n) => n.allowedDomains), suffixes: every((n) => n.allowedDomainSuffixes) };
}

// The guest a spawn boots: its template's, or with its brain's memory
// mounted, `<template>+<brain>`, when this host binds the brain.
export const guestOf = (m: Manifest, s: Spawn) => (s.brain && m.bindings?.[s.brain]?.shares.length ? `${s.template}+${s.brain}` : s.template);
