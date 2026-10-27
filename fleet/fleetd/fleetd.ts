// fleetd: starts queued spawns in free slots, within the memory budget, and
// collects what each agent hands back when its slot stops. A user service
// (fleet/host), polling every two seconds; the slots are system units it
// may start and stop by a polkit rule.
//
// Starting one: the template goes in the slot's state dir (its launcher
// reads it), the task, a Claude Code token and the repo bundle in its
// share, then `systemctl start`. The guest runs the task and powers off,
// which ends the unit.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_TOKEN, manifest, schedule, SPAWNS, spawns, write, type Manifest, type Spawn } from "./fleet";

const now = () => new Date().toISOString();

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out: (out + err).trim() };
}

// The units that are up, or on their way up: `is-active` prints one state
// per unit, in order.
async function activeUnits(m: Manifest): Promise<Set<string>> {
  const units = [...Object.values(m.slots).map((s) => s.unit), ...Object.values(m.residents).map((r) => r.unit)];
  const { out } = await run(["systemctl", "is-active", ...units]);
  const states = out.split("\n");
  return new Set(units.filter((_, i) => states[i] === "active" || states[i] === "activating" || states[i] === "reloading"));
}

function empty(dir: string) {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
}

async function start(m: Manifest, s: Spawn, slot: string) {
  const sl = m.slots[slot];
  if (!existsSync(CLAUDE_TOKEN)) throw new Error(`no Claude Code token at ${CLAUDE_TOKEN} (claude setup-token, then save it there)`);
  empty(sl.shareDir);
  empty(sl.outboxDir);
  writeFileSync(join(sl.shareDir, "task.md"), s.task);
  copyFileSync(CLAUDE_TOKEN, join(sl.shareDir, "claude-token"));
  if (s.repo) {
    const b = await run(["git", "-C", s.repo, "bundle", "create", join(sl.shareDir, "repo.bundle"), "HEAD", "--branches"]);
    if (!b.ok) throw new Error(`couldn't bundle ${s.repo}: ${b.out}`);
  }
  writeFileSync(join(sl.stateDir, "template"), s.template + "\n");
  const r = await run(["systemctl", "start", "--no-block", sl.unit]);
  if (!r.ok) throw new Error(`couldn't start ${sl.unit}: ${r.out}`);
}

// Its outbox, into the spawn's own directory, before the slot is reused.
function collect(m: Manifest, s: Spawn) {
  const sl = m.slots[s.slot!];
  const dir = join(SPAWNS, s.id);
  mkdirSync(dir, { recursive: true });
  if (existsSync(sl.outboxDir)) cpSync(sl.outboxDir, dir, { recursive: true });
  const exit = existsSync(join(dir, "exit")) ? Number(readFileSync(join(dir, "exit"), "utf8").trim()) : undefined;
  return exit;
}

async function tick() {
  const m = manifest();
  const all = spawns();
  const active = await activeUnits(m);

  for (const s of all) {
    if (s.state === "queued" && s.stopRequested) write({ ...s, state: "stopped", ended: now() });
    if (s.state !== "running") continue;
    const unit = m.slots[s.slot!]?.unit;
    if (unit && active.has(unit)) {
      if (s.stopRequested) await run(["systemctl", "stop", "--no-block", unit]);
      continue;
    }
    const exit = collect(m, s);
    const state = s.stopRequested ? "stopped" : exit === 0 ? "done" : "failed";
    write({ ...s, state, exit, ended: now(), error: exit === undefined && !s.stopRequested ? "the slot stopped without finishing the task (journalctl -u " + unit + ")" : s.error });
    s.state = state;
  }

  const plan = schedule(m, spawns(), await activeUnits(m));
  for (const f of plan.fail) {
    const s = all.find((x) => x.id === f.id)!;
    write({ ...s, state: "failed", error: f.error, ended: now() });
  }
  for (const { id, slot } of plan.start) {
    const s = all.find((x) => x.id === id)!;
    try {
      await start(m, s, slot);
      write({ ...s, state: "running", slot, started: now() });
      console.log(`${id}: ${s.template} in ${slot}`);
    } catch (e: any) {
      write({ ...s, state: "failed", error: String(e?.message ?? e), ended: now() });
      console.error(`${id}: ${e?.message ?? e}`);
    }
  }
}

console.log("fleetd: watching", SPAWNS);
for (;;) {
  await tick().catch((e) => console.error("fleetd:", e));
  await Bun.sleep(2000);
}
