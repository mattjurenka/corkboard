// What fleetd and corkboard-fleet share: the host's manifest (written by
// fleet/host as /etc/corkboard/fleet.json), the spawns on disk, and the
// one decision that matters, which queued spawns start now.
//
// A spawn is a file, ~/.local/state/corkboard/fleet/spawns/<id>.json, and
// what its agent handed back is the directory of the same name. The CLI
// writes queued spawns; fleetd is the only thing that moves them on.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Manifest = {
  flake: string;
  owner: string;
  // MiB the agents may have between them, or null for no limit.
  memoryBudget: number | null;
  slots: Record<string, { guestAddress: string; stateDir: string; shareDir: string; outboxDir: string; unit: string }>;
  // VMs that are always there: they count against the budget while up.
  residents: Record<string, { unit: string; memory: number | null }>;
  templates: Record<string, { memory: number; cores: number; needsApproval: boolean; brain: string | null; capNames: string[] }>;
};

export type State = "queued" | "running" | "done" | "failed" | "stopped";

export type Spawn = {
  id: string;
  template: string;
  task: string;
  // A repo on this machine to work in; its commits come back as a bundle.
  repo?: string;
  // Who asked: "user" for the CLI. A brain's spawn of a template that needs
  // approval waits for it (the Worker's queue, step 4); the CLI's never does.
  by: string;
  state: State;
  created: string;
  slot?: string;
  started?: string;
  ended?: string;
  exit?: number;
  error?: string;
  stopRequested?: boolean;
};

export const MANIFEST = process.env.CORKBOARD_FLEET_MANIFEST ?? "/etc/corkboard/fleet.json";
export const STATE = process.env.CORKBOARD_FLEET_STATE ?? join(homedir(), ".local/state/corkboard/fleet");
export const SPAWNS = join(STATE, "spawns");
// A Claude Code OAuth token from `claude setup-token`, handed to each agent.
export const CLAUDE_TOKEN = join(STATE, "claude-token");

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

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export type Plan = {
  start: { id: string; slot: string }[];
  fail: { id: string; error: string }[];
  // Why the first spawn still queued is waiting, if one is.
  waiting?: { id: string; reason: string };
};

// Which queued spawns to start, given what is running. In order: a spawn
// that doesn't fit waits, and so does everything behind it, so a big spawn
// is never starved by small ones.
export function schedule(m: Manifest, all: Spawn[], active: Set<string>): Plan {
  const plan: Plan = { start: [], fail: [] };
  const running = all.filter((s) => s.state === "running");
  let used =
    Object.values(m.residents).reduce((n, r) => n + (active.has(r.unit) ? r.memory ?? 0 : 0), 0) +
    running.reduce((n, s) => n + (m.templates[s.template]?.memory ?? 0) + OVERHEAD, 0);
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
