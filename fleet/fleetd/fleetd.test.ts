// fleetd's tick, with systemctl stood in for: what it puts in a slot's
// share and state dir when it starts a spawn there, what it does to one
// asked to stop, and what it makes of one whose slot has stopped.   bun test fleet/fleetd
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawn } from "./fleet";

const dir = mkdtempSync(join(tmpdir(), "fleetd-"));
const slot = (n: number) => ({
  guestAddress: `10.${80 + n}.0.2`,
  stateDir: join(dir, `agent-${n}`),
  shareDir: join(dir, `agent-${n}/share`),
  outboxDir: join(dir, `agent-${n}/outbox`),
  unit: `agent-${n}.service`,
});
const slots = { "agent-0": slot(0), "agent-1": slot(1) };
const manifest = {
  flake: "",
  owner: "matthew",
  memoryBudget: null,
  slots,
  residents: {},
  templates: {
    coding: { memory: 4096, cores: 2, needsApproval: false, capNames: ["coding"] },
    gemini: { memory: 4096, cores: 2, needsApproval: false, capNames: [], agent: "agy" },
    runner: { memory: 2048, cores: 2, needsApproval: false, capNames: [] },
  },
  bindings: { work: { shares: ["vault"] } },
  defaultAccount: "personal",
};

// systemctl: each unit's state, and what it was told.
const units = new Map<string, string>();
const told: string[][] = [];
let refuse = false;

let fleet: typeof import("./fleet");
let fleetd: typeof import("./fleetd");

beforeAll(async () => {
  process.env.CORKBOARD_FLEET_STATE = join(dir, "fleet");
  process.env.CORKBOARD_FLEET_MANIFEST = join(dir, "fleet.json");
  process.env.CORKBOARD_STATE_DIR = join(dir, "state");
  process.env.CORKBOARD_CLOUD = "http://localhost:9";
  writeFileSync(process.env.CORKBOARD_FLEET_MANIFEST, JSON.stringify(manifest));
  for (const s of Object.values(slots)) mkdirSync(s.outboxDir, { recursive: true }), mkdirSync(s.shareDir, { recursive: true });
  fleet = await import("./fleet");
  // Paths are read at import: never let a module loaded earlier point this at the real state.
  if (!fleet.SPAWNS.startsWith(dir)) throw new Error("fleet's paths aren't the test's");
  mkdirSync(fleet.ACCOUNTS, { recursive: true });
  writeFileSync(fleet.tokenFor("personal"), "sk-personal\n");
  fleetd = await import("./fleetd");
  const real = fleetd.sh.run;
  fleetd.sh.run = async (cmd) => {
    if (cmd[0] !== "systemctl") return real(cmd);
    told.push(cmd.slice(1));
    const [verb, ...rest] = cmd.slice(1);
    if (verb === "is-active") return { ok: true, out: rest.map((u) => units.get(u) ?? "inactive").join("\n") };
    const unit = rest.at(-1)!;
    if (refuse) return { ok: false, out: `Failed to start ${unit}: Access denied` };
    if (verb === "start") units.set(unit, "activating");
    if (verb === "stop") units.delete(unit);
    return { ok: true, out: "" };
  };
});

beforeEach(() => {
  rmSync(fleet.SPAWNS, { recursive: true, force: true });
  units.clear();
  told.length = 0;
  refuse = false;
});

let n = 0;
const queue = (s: Partial<Spawn> = {}): Spawn => {
  const spawn: Spawn = { id: `sp${++n}`, template: "coding", task: "fix the tests", by: "user", account: "personal", state: "queued", created: `2026-11-20T00:00:${String(n).padStart(2, "0")}Z`, ...s };
  fleet.write(spawn);
  return spawn;
};
const share = (slot: string, f: string) => readFileSync(join(slots[slot as keyof typeof slots].shareDir, f), "utf8");
const state = (slot: string, f: string) => join(slots[slot as keyof typeof slots].stateDir, f);
const mode = (f: string) => statSync(f).mode & 0o777;
// The slot's guest ran and powered off, leaving its outbox.
const finish = (slot: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) writeFileSync(join(slots[slot as keyof typeof slots].outboxDir, f), text);
  units.delete(slots[slot as keyof typeof slots].unit);
};

test("a queued spawn starts in a free slot: its task and token in the share, its guest in the state dir", async () => {
  const s = queue();
  writeFileSync(join(slots["agent-0"].shareDir, "left-by-the-last"), "x");
  await fleetd.tick();
  expect(fleet.read(s.id)).toMatchObject({ state: "running", slot: "agent-0", started: expect.any(String) });
  expect(told).toContainEqual(["start", "--no-block", "agent-0.service"]);
  expect(readdirSync(slots["agent-0"].shareDir).sort()).toEqual(["claude-token", "task.md"]);
  expect(share("agent-0", "task.md")).toBe("fix the tests");
  expect(share("agent-0", "claude-token")).toBe("sk-personal\n");
  expect(readFileSync(state("agent-0", "template"), "utf8")).toBe("coding\n");
  expect(existsSync(state("agent-0", "size"))).toBe(false);
  // Its unit is up now, so the next tick leaves it be.
  told.length = 0;
  await fleetd.tick();
  expect(told.filter((c) => c[0] !== "is-active")).toEqual([]);
});

test("one that asked for a size gets it, and a brain this host binds boots with its memory", async () => {
  const a = queue({ memory: 8192, cores: 4 }), b = queue({ brain: "work", account: "personal" });
  await fleetd.tick();
  expect([fleet.read(a.id)!.slot, fleet.read(b.id)!.slot]).toEqual(["agent-0", "agent-1"]);
  expect(readFileSync(state("agent-0", "size"), "utf8")).toBe("8192 4\n");
  expect(readFileSync(state("agent-1", "template"), "utf8")).toBe("coding+work\n");
  // A size goes with the spawn, not the slot.
  finish("agent-0", { exit: "0" });
  queue();
  await fleetd.tick();
  expect(existsSync(state("agent-0", "size"))).toBe(false);
});

test("an agent of another kind gets its own credential; with none, the spawn fails saying how to make it", async () => {
  writeFileSync(join(fleet.ACCOUNTS, "personal.agy"), "GEMINI_API_KEY=g\n");
  const a = queue({ template: "gemini" }), b = queue({ account: "work" });
  await fleetd.tick();
  expect(fleet.read(a.id)!.state).toBe("running");
  expect(share("agent-0", "agy-credential")).toBe("GEMINI_API_KEY=g\n");
  expect(fleet.read(b.id)).toMatchObject({ state: "failed", error: expect.stringContaining(`no claude-token for the work account at ${fleet.tokenFor("work")} (claude setup-token`) });
  // It never took the slot.
  expect(told).not.toContainEqual(["start", "--no-block", "agent-1.service"]);
});

test("one from the Worker's queue on a card is told its card, and holds its grants and secrets, the owner's only", async () => {
  const s = queue({
    brain: "work",
    remote: { board: "proj", card: "TASK-7", agent: "coding-sp", token: "cbn_card", mcp: "http://node.test/mcp", brainToken: "cbn_brain", memory: "http://node.test", secrets: { github: "ghp_x", google: "refresh" } },
  });
  await fleetd.tick();
  expect(fleet.read(s.id)!.state).toBe("running");
  const task = share("agent-0", "task.md");
  expect(task.startsWith("fix the tests\n\n---\nThis task is corkboard card TASK-7 on the proj board, and you are its agent, coding-sp.")).toBe(true);
  expect(task).toContain("claim_card it first");
  expect(task).toContain("What you hold is in /mnt/share/secrets/, a file each: github, google.");
  const sh = slots["agent-0"].shareDir;
  expect(JSON.parse(share("agent-0", "mcp.json"))).toEqual({ mcpServers: { corkboard: { type: "http", url: "http://node.test/mcp", headers: { Authorization: "Bearer cbn_card" } } } });
  expect(share("agent-0", "brain-token")).toBe("cbn_brain\n");
  expect(share("agent-0", "memory-url")).toBe("http://node.test\n");
  expect(share("agent-0", "secrets/github")).toBe("ghp_x");
  expect([mode(join(sh, "mcp.json")), mode(join(sh, "brain-token")), mode(join(sh, "secrets")), mode(join(sh, "secrets/google"))]).toEqual([0o600, 0o600, 0o700, 0o600]);
});

test("a task on no card is told its answer is the result, and one on no board is told nothing", async () => {
  queue({ remote: { board: "proj", card: null, agent: "coding-x", token: "t", mcp: "http://node.test/mcp" } });
  queue({ remote: { board: null, card: null, agent: "coding-y", token: null } });
  await fleetd.tick();
  expect(share("agent-0", "task.md")).toContain("with no card of its own; your final answer is its result.");
  expect(share("agent-1", "task.md")).toBe("fix the tests");
  expect(existsSync(join(slots["agent-1"].shareDir, "mcp.json"))).toBe(false);
});

test("a session has its first message in the inbox, and is told it's on the board", async () => {
  queue({ interactive: true, remote: { board: "proj", card: null, agent: "coding-s", token: "t", mcp: "http://node.test/mcp" } });
  await fleetd.tick();
  expect(share("agent-0", "session")).toBe("");
  const first = JSON.parse(share("agent-0", "inbox/0"));
  expect(first).toMatchObject({ type: "user", message: { role: "user" } });
  expect(first.message.content).toStartWith("fix the tests\n\n---\nThis session is on the corkboard proj board, as coding-s, with no card of its own.");
});

test("a repo goes in as a bundle of its branches", async () => {
  const repo = join(dir, "repo");
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("branch", "side");
  queue({ repo, shell: { packages: ["ripgrep"] } });
  await fleetd.tick();
  const bundle = join(slots["agent-0"].shareDir, "repo.bundle");
  const heads = Bun.spawnSync(["git", "bundle", "list-heads", bundle]).stdout.toString();
  expect(heads).toContain("refs/heads/main");
  expect(heads).toContain("refs/heads/side");
  expect(JSON.parse(share("agent-0", "shell.json"))).toEqual({ packages: ["ripgrep"] });
  // A repo that isn't one fails the spawn, not fleetd.
  const bad = queue({ repo: join(dir, "nowhere") });
  await fleetd.tick();
  expect(fleet.read(bad.id)).toMatchObject({ state: "failed", error: expect.stringContaining(`couldn't bundle ${join(dir, "nowhere")}`) });
});

test("an Actions job needs the manifest's Actions, and holds no account's token", async () => {
  const actions = { handle: "h1", job: 1, run: 2, runner: 3, uuid: "u-1", token: "runner-secret" };
  const s = queue({ template: "runner", account: "", job: "actions", actions });
  await fleetd.tick();
  expect(fleet.read(s.id)).toMatchObject({ state: "failed", error: expect.stringContaining("no Actions here") });

  writeFileSync(process.env.CORKBOARD_FLEET_MANIFEST!, JSON.stringify({ ...manifest, actions: { url: "http://forgejo.test", tokenFile: join(dir, "none"), labels: ["fleet"], template: "runner" } }));
  try {
    const t = queue({ template: "runner", account: "", job: "actions", actions });
    await fleetd.tick();
    expect(fleet.read(t.id)!.state).toBe("running");
    expect(JSON.parse(share("agent-0", "actions.json"))).toEqual({ url: "http://forgejo.test", uuid: "u-1", handle: "h1", labels: ["fleet"] });
    expect(share("agent-0", "runner-token")).toBe("runner-secret\n");
    expect(share("agent-0", "job")).toBe("actions\n");
    expect(readdirSync(slots["agent-0"].shareDir)).not.toContain("claude-token");
  } finally {
    writeFileSync(process.env.CORKBOARD_FLEET_MANIFEST!, JSON.stringify(manifest));
  }
});

test("a unit that won't start fails its spawn, and a spawn of no template here fails without a slot", async () => {
  refuse = true;
  const a = queue(), b = queue({ template: "nope" });
  await fleetd.tick();
  expect(fleet.read(a.id)).toMatchObject({ state: "failed", error: "couldn't start agent-0.service: Failed to start agent-0.service: Access denied" });
  expect(fleet.read(b.id)).toMatchObject({ state: "failed", error: "no spawnable template nope here" });
});

test("when its slot stops, what it handed back is kept, and its exit says done or failed", async () => {
  const a = queue(), b = queue(), c = queue();
  await fleetd.tick();
  finish("agent-0", { exit: "0\n", "result.json": JSON.stringify({ result: "Fixed." }) });
  finish("agent-1", { exit: "3" });
  await fleetd.tick();
  expect(fleet.read(a.id)).toMatchObject({ state: "done", exit: 0, ended: expect.any(String) });
  expect(fleet.answer(fleet.read(a.id)!)).toBe("Fixed.");
  expect(fleet.read(b.id)).toMatchObject({ state: "failed", exit: 3 });
  expect(fleet.read(b.id)!.error).toBeUndefined();
  // The freed slot takes the next, from an empty outbox.
  expect(fleet.read(c.id)).toMatchObject({ state: "running", slot: "agent-0" });
  expect(readdirSync(slots["agent-0"].outboxDir)).toEqual([]);
  // One that stopped without an exit didn't finish.
  units.delete("agent-0.service");
  await fleetd.tick();
  expect(fleet.read(c.id)).toMatchObject({ state: "failed", error: "the slot stopped without finishing the task (journalctl -u agent-0.service)" });
});

test("a stop: a queued spawn never starts, and a running task's unit is stopped", async () => {
  const q = queue({ stopRequested: true });
  const r = queue();
  await fleetd.tick();
  expect(fleet.read(q.id)!.state).toBe("stopped");
  expect(fleet.read(r.id)!.slot).toBe("agent-0");
  fleet.write({ ...fleet.read(r.id)!, stopRequested: true });
  await fleetd.tick();
  expect(told).toContainEqual(["stop", "--no-block", "agent-0.service"]);
  await fleetd.tick();
  expect(fleet.read(r.id)!.state).toBe("stopped");
  expect(fleet.read(r.id)!.error).toBeUndefined();
});

test("a session asked to stop is asked to finish first, and one that does is done", async () => {
  const s = queue({ interactive: true });
  await fleetd.tick();
  fleet.write({ ...fleet.read(s.id)!, stopRequested: true });
  await fleetd.tick();
  expect(share("agent-0", "inbox/1")).toBe("END\n");
  expect(fleet.read(s.id)!.ending).toEqual(expect.any(String));
  expect(told).not.toContainEqual(["stop", "--no-block", "agent-0.service"]);
  // Still finishing a minute on: left to.
  await fleetd.tick();
  expect(told).not.toContainEqual(["stop", "--no-block", "agent-0.service"]);
  expect(readdirSync(join(slots["agent-0"].shareDir, "inbox")).sort()).toEqual(["0", "1"]);
  finish("agent-0", { exit: "0" });
  await fleetd.tick();
  expect(fleet.read(s.id)!.state).toBe("done");
});

test("a session that hasn't finished two minutes after it was asked is stopped", async () => {
  const s = queue({ interactive: true });
  await fleetd.tick();
  fleet.write({ ...fleet.read(s.id)!, stopRequested: true, ending: new Date(Date.now() - 121_000).toISOString() });
  await fleetd.tick();
  expect(told).toContainEqual(["stop", "--no-block", "agent-0.service"]);
  await fleetd.tick();
  expect(fleet.read(s.id)!.state).toBe("stopped");
});
