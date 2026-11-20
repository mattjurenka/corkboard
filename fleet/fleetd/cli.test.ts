// corkboard-fleet, run as it is, on a manifest and state dir of the test's
// and a stand-in Worker: what it writes for a spawn, what it shows, and
// what it refuses.   bun test fleet/fleetd
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify, newDevice } from "../../lib/e2ee/device";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import type { Spawn } from "./fleet";

const dir = mkdtempSync(join(tmpdir(), "fleet-cli-"));
const state = join(dir, "fleet");
const spawnsDir = join(state, "spawns");
const manifest = join(dir, "fleet.json");
const cli = join(import.meta.dir, "cli.ts");
// The Worker's tokens, as fleetd's device would have them.
const preload = join(dir, "token.ts");
writeFileSync(preload, `import { setRelay } from ${JSON.stringify(join(import.meta.dir, "../../bridge/cloud.ts"))};\nsetRelay({ token: async () => "owner" });\n`);

const asked: { method: string; path: string }[] = [];
const worker = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    asked.push({ method: req.method, path: url.pathname + url.search });
    if (req.headers.get("authorization") !== "Bearer owner") return Response.json({ error: "who?" }, { status: 401 });
    if (url.pathname === "/api/spawns")
      return Response.json([
        { id: "q1", state: "pending-approval", template: "coding", environment: "omni", by: "pepper", board: "proj", card: "TASK-1", created: "2026-11-20T09:15:00Z", task: "Fix the build\nand then" },
        { id: "q2", state: "running", template: "coding", environment: "droplet", by: "user", board: null, card: null, created: "2026-11-20T10:00:00Z", task: "look around" },
      ]);
    if (url.pathname === "/api/spawns/q1/approve") return Response.json({ id: "q1", template: "coding", environment: "omni" });
    return Response.json({ error: "no such spawn" }, { status: 404 });
  },
});
afterAll(() => void worker.stop(true));

const write = (m: object) => writeFileSync(manifest, JSON.stringify(m));
const base = {
  flake: "",
  owner: "matthew",
  memoryBudget: 4096,
  slots: { "agent-0": { guestAddress: "", stateDir: "", shareDir: "", outboxDir: "", unit: "agent-0.service" } },
  residents: {},
  templates: {
    coding: { memory: 2048, cores: 2, needsApproval: false, capNames: ["coding", "github"] },
    mail: { memory: 1024, cores: 1, needsApproval: true, capNames: [], agent: "agy" },
  },
  bindings: { work: { shares: ["vault", "notes"] }, pepper: { shares: [] } },
  defaultAccount: "personal",
};

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", "--preload", preload, cli, ...args], {
    env: { ...process.env, CORKBOARD_FLEET_MANIFEST: manifest, CORKBOARD_FLEET_STATE: state, CORKBOARD_STATE_DIR: join(dir, "state"), CORKBOARD_CLOUD: `http://localhost:${worker.port}`, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  p.stdin.end();
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err: err.trim() };
}
const read = (id: string): Spawn => JSON.parse(readFileSync(join(spawnsDir, `${id}.json`), "utf8"));
const ids = () => readdirSync(spawnsDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

beforeAll(() => write(base));

test("spawn queues one, as the default account, sized at least as its template", async () => {
  const r = await run("spawn", "coding", "--memory", "1024", "--cores", "8", "--packages", "ripgrep,,jq", "fix", "the", "tests");
  expect(r).toMatchObject({ code: 0, err: "" });
  const s = read(r.out);
  expect(s).toMatchObject({ id: r.out, template: "coding", task: "fix the tests", by: "user", account: "personal", state: "queued", memory: 2048, cores: 8, shell: { packages: ["ripgrep", "jq"] } });
  expect(s.repo).toBeUndefined();
});

test("one that won't fit says why it's queued", async () => {
  // The first takes 2048 + 512 of the 4096, so a second waits.
  const r = await run("spawn", "coding", "--account", "work", "--shell", "github:me/env", "--memory", "3000", "more");
  expect(r.code).toBe(0);
  const [id, why] = r.out.split("  ");
  expect(why).toBe(`(queued: needs ${3000 + 512} MiB; ${4096 - 2048 - 512} of 4096 free)`);
  expect(read(id)).toMatchObject({ account: "work", shell: { flake: "github:me/env" }, memory: 3000 });
});

test("spawn refuses what it can't queue, writing nothing", async () => {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const before = ids().length;
  const cases: [string[], string][] = [
    [["nope", "x"], "spawnable here: coding, mail"],
    [["constructor", "x"], "spawnable here: coding, mail"],
    [[], "spawnable here: coding, mail"],
    [["coding"], "what should it do? corkboard-fleet spawn <template> <task...>"],
    [["coding", "--repo", repo, "x"], `${repo} is not a git repo`],
    [["coding", "--memory", "lots", "x"], "--memory needs a whole number"],
    [["coding", "--cores", "0", "x"], "--cores needs a whole number"],
    [["coding", "--account", "../etc", "x"], "no account ../etc"],
    [["coding", "x", "--repo"], "--repo needs a directory"],
  ];
  for (const [args, err] of cases) expect(await run("spawn", ...args)).toMatchObject({ code: 1, err });
  write({ ...base, defaultAccount: null });
  try {
    expect(await run("spawn", "coding", "x")).toMatchObject({ code: 1, err: "which account? --account <name> (there is no default)" });
  } finally {
    write(base);
  }
  expect(ids().length).toBe(before);
});

test("spawn takes a repo, as an absolute path", async () => {
  const repo = join(dir, "work");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const p = Bun.spawn(["bun", "--preload", preload, cli, "spawn", "coding", "--repo", "work", "go"], {
    cwd: dir,
    env: { ...process.env, CORKBOARD_FLEET_MANIFEST: manifest, CORKBOARD_FLEET_STATE: state },
    stdout: "pipe",
  });
  const id = (await new Response(p.stdout).text()).trim().split("  ")[0];
  expect(read(id).repo).toBe(repo);
});

test("list shows each, in the order made", async () => {
  const r = await run("list");
  const rows = r.out.split("\n");
  expect(rows.length).toBe(ids().length);
  expect(rows[0]).toMatch(/^\w+ +queued +coding +personal +\d\d-\d\d \d\d:\d\d +fix the tests$/);
});

test("show gives the spawn, its answer and its commits; stop asks it to stop, once", async () => {
  const [id] = ids().sort((a, b) => read(a).created.localeCompare(read(b).created));
  mkdirSync(join(spawnsDir, id), { recursive: true });
  writeFileSync(join(spawnsDir, id, "result.json"), JSON.stringify({ result: "All green." }));
  writeFileSync(join(spawnsDir, id, "work.bundle"), "");
  const r = await run("show", id);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`"id": "${id}"`);
  expect(r.out).toContain("\n\nAll green.\n\ncommits: corkboard-fleet fetch " + id);
  expect(await run("stop", id)).toMatchObject({ code: 0, out: `stopping ${id}` });
  expect(read(id).stopRequested).toBe(true);
  writeFileSync(join(spawnsDir, `${id}.json`), JSON.stringify({ ...read(id), state: "done" }));
  expect(await run("stop", id)).toMatchObject({ code: 1, err: `${id} is already done` });
  for (const c of ["show", "stop", "fetch", "attach"]) expect(await run(c, "nope")).toMatchObject({ code: 1, err: "no spawn nope; see corkboard-fleet list" });
  expect(await run("show")).toMatchObject({ code: 1, err: "no spawn (none given); see corkboard-fleet list" });
});

test("fetch brings its commits into its repo as fleet/<id>", async () => {
  const repo = join(dir, "fetched");
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("checkout", "-q", "-b", "fleet-result");
  git("commit", "-q", "--allow-empty", "-m", "the fix");
  const id = "fetchme";
  mkdirSync(join(spawnsDir, id), { recursive: true });
  git("bundle", "create", "-q", join(spawnsDir, id, "work.bundle"), "main..fleet-result");
  git("checkout", "-q", "main");
  git("branch", "-q", "-D", "fleet-result");
  const s: Spawn = { id, template: "coding", task: "t", by: "user", account: "personal", state: "done", created: "2026-11-20T00:00:00Z", repo };
  writeFileSync(join(spawnsDir, `${id}.json`), JSON.stringify(s));
  expect(await run("fetch", id)).toMatchObject({ code: 0, out: expect.stringContaining(`fleet/${id} in ${repo}`) });
  expect(git("log", "-1", "--format=%s", `fleet/${id}`).stdout.toString().trim()).toBe("the fix");
  // None without a repo, or with nothing brought back.
  writeFileSync(join(spawnsDir, `${id}.json`), JSON.stringify({ ...s, repo: undefined }));
  expect(await run("fetch", id)).toMatchObject({ code: 1, err: `${id} had no repo` });
  writeFileSync(join(spawnsDir, "bare.json"), JSON.stringify({ ...s, id: "bare" }));
  expect(await run("fetch", "bare")).toMatchObject({ code: 1, err: "bare brought back no commits" });
});

test("attach is the slot's ssh while it runs", async () => {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin/agent-0-ssh"), "#!/bin/sh\necho in agent-0\nexit 7\n");
  chmodSync(join(dir, "bin/agent-0-ssh"), 0o755);
  const s: Spawn = { id: "live", template: "coding", task: "t", by: "user", account: "personal", state: "running", slot: "agent-0", created: "2026-11-20T00:00:00Z" };
  writeFileSync(join(spawnsDir, "live.json"), JSON.stringify(s));
  expect(await run("attach", "live")).toMatchObject({ code: 7, out: "in agent-0" });
  writeFileSync(join(spawnsDir, "live.json"), JSON.stringify({ ...s, state: "queued" }));
  expect(await run("attach", "live")).toMatchObject({ code: 1, err: "live is queued, not running" });
});

test("templates lists what's spawnable here and the brains' memory", async () => {
  expect((await run("templates")).out.split("\n")).toEqual([
    "coding  claude, 2048 MiB, 2 cores, coding github",
    "mail  agy, 1024 MiB, 1 cores, -  (holds credentials)",
    "work's memory: vault notes",
    "pepper's memory: -",
  ]);
});

test("queue and approve are the Worker's, as fleetd's device", async () => {
  const q = await run("queue");
  expect(q.code).toBe(0);
  expect(q.out.split("\n")).toEqual([
    "q1  pending-approval  coding  omni     pepper  proj/TASK-1  11-20 09:15  Fix the build",
    "q2  running           coding  droplet  user    -/-          11-20 10:00  look around",
  ]);
  expect(asked.at(-1)).toEqual({ method: "GET", path: "/api/spawns?limit=30" });
  expect(await run("approve", "q1")).toMatchObject({ code: 0, out: "q1 approved: coding, queued for omni" });
  expect(asked.at(-1)).toEqual({ method: "POST", path: "/api/spawns/q1/approve" });
  expect(await run("approve", "q9")).toMatchObject({ code: 1, err: "no such spawn" });
  expect(await run("approve")).toMatchObject({ code: 1, err: "which spawn? corkboard-fleet queue lists them" });
});

test("device makes fleetd's keys once and says how to certify them; a cert that isn't for them is refused", async () => {
  const file = join(dir, "device.json");
  const r = await run("device", file);
  expect(r.code).toBe(0);
  const id = r.out.match(/: device (\S+)/)![1];
  expect(r.out).toContain(`corkboard-bridge e2ee relay-device ${id} `);
  expect(r.out).toContain(`corkboard-fleet device cert ${file} < cert.json`);
  expect((await run("device", file)).out).toContain(`device ${id}`);
  // Another device's cert, through stdin.
  const keys = accountKeys(newRoot());
  const cert = JSON.stringify(certify(keys, newDevice(), "fleetd", Date.now(), "relay"));
  const p = Bun.spawn(["bun", cli, "device", "cert", file], { env: { ...process.env, CORKBOARD_FLEET_MANIFEST: manifest, CORKBOARD_FLEET_STATE: state }, stdin: new TextEncoder().encode(cert), stderr: "pipe" });
  expect([await p.exited, (await new Response(p.stderr).text()).trim()]).toEqual([1, "that cert is another device's"]);
  // With no file named, the manifest's, else the state dir's.
  expect((await run("device")).out).toStartWith(`${join(state, "device.json")}: device `);
  expect(existsSync(join(state, "device.json"))).toBe(true);
});

test("anything else is the usage", async () => {
  expect(await run("frobnicate")).toMatchObject({ code: 1, err: "corkboard-fleet spawn|list|show|attach|stop|fetch|templates|queue|approve|device" });
});
