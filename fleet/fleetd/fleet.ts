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
  slots: Record<string, { guestAddress: string; stateDir: string; shareDir: string; outboxDir: string; unit: string; network?: Network }>;
  // VMs that are always there: they count against the budget while up.
  residents: Record<
    string,
    { unit: string; memory: number | null; brain?: string | null; account?: string | null; cores?: number | null; capNames?: string[]; network?: Network }
  >;
  templates: Record<string, { memory: number; cores: number; needsApproval: boolean; brain: string | null; account: string | null; capNames: string[] }>;
  // Each brain's Claude account, and the one a brainless template runs as
  // when the user spawns it without saying.
  brains: Record<string, { account: string | null }>;
  defaultAccount: string | null;
};

export type State = "queued" | "running" | "done" | "failed" | "stopped";

export type Spawn = {
  id: string;
  template: string;
  task: string;
  // A repo on this machine to work in; its commits come back as a bundle.
  repo?: string;
  // Who asked: "user", or a brain. A brain's spawn of a template that needs
  // approval waited for it in the Worker's queue; the CLI's never does.
  by: string;
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
  // From the Worker's queue: its card, and the spawn token for it (emptied
  // once it's revoked, at the end).
  remote?: { board: string; card: string; agent: string; token: string };
  // A session you talk to rather than a task (sessions.ts); when it was
  // asked to finish, if it has been.
  interactive?: boolean;
  ending?: string;
  // The last state the Worker was told of.
  reported?: State;
  // The branch its commits were fetched into, in its repo.
  fetched?: string;
};

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
  slots: { name: string; spawn: string | null; template: string | null; memory: number | null; config?: Config }[];
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
      cores: t?.cores ?? null,
      capabilities: t?.capNames ?? [],
      account: s?.account ?? null,
      ...(t && { needsApproval: t.needsApproval }),
    };
    return { name, spawn: s?.id ?? null, template: s?.template ?? null, memory: s ? (t?.memory ?? 0) + OVERHEAD : null, ...(config && { config }) };
  });
  // A running spawn whose slot left the manifest still takes its memory.
  const lost = all.filter((s) => s.state === "running" && !m.slots[s.slot!]);
  const used =
    residents.reduce((n, r) => n + (r.up ? r.memory ?? 0 : 0), 0) +
    slots.reduce((n, s) => n + (s.memory ?? 0), 0) +
    lost.reduce((n, s) => n + (m.templates[s.template]?.memory ?? 0) + OVERHEAD, 0);
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
    const need = t.memory + OVERHEAD;
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

// The account a spawn runs as. A brain's template runs as the brain's
// account, and nothing else: its agents share the brain's memory, so they
// share its account too. A brainless one runs as what was asked for, or
// the account of the brain that spawned it, or the host's default.
export function accountFor(m: Manifest, template: string, by: string, asked?: string): string {
  const t = m.templates[template];
  if (t?.brain) {
    if (!t.account) throw new Error(`the ${t.brain} brain has no account`);
    if (asked && asked !== t.account) throw new Error(`${template} is the ${t.brain} brain's, which runs as ${t.account}`);
    return t.account;
  }
  const account = asked ?? (by === "user" ? m.defaultAccount : m.brains[by]?.account);
  if (!account) throw new Error(`which account? --account <name> (there is no default)`);
  // A file name under ACCOUNTS.
  if (!/^[\w-]+$/.test(account)) throw new Error(`no account ${account}`);
  return account;
}
