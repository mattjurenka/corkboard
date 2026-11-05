// fleetd's side of the Worker's queue, against a stand-in Worker: what it
// claims, what it passes on, and what it reports.   bun test fleet/fleetd
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Remote = {
  id: string;
  template: string;
  task: string;
  by: string;
  brain?: string | null;
  account?: string | null;
  state: string;
  environment: string;
  board: string | null;
  card: string | null;
  agent: string;
  stopRequested?: boolean;
};

const dir = mkdtempSync(join(tmpdir(), "fleet-queue-"));
const repo = join(dir, "repo");
const remote: Remote[] = [];
const calls: { method: string; path: string; body: any }[] = [];
let environment: any;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    calls.push({ method: req.method, path: url.pathname, body });
    if (req.headers.get("authorization") !== "Bearer owner") return Response.json({ error: "who?" }, { status: 401 });
    if (url.pathname === "/api/fleet/environments/local") return Response.json((environment = body));
    if (url.pathname === "/api/spawns") return Response.json(remote.filter((s) => url.searchParams.get("state")!.split(",").includes(s.state)));
    if (url.pathname === "/api/tokens/revoke") return new Response(null, { status: 204 });
    const m = url.pathname.match(/^\/api\/spawns\/(\w+)\/(claim|report)$/);
    const s = remote.find((x) => x.id === m?.[1]);
    if (!s) return Response.json({ error: "no" }, { status: 404 });
    if (m![2] === "claim") return Response.json({ spawn: s, token: s.board ? `cbc_${s.id}` : null, repo: s.board === "proj" ? repo : null, ...(s.brain && { brainToken: `cbb_${s.id}`, secrets: { github: "ghp_x" } }) });
    s.state = body.state;
    return Response.json(s);
  },
});

let fleet: typeof import("./fleet");
let queue: InstanceType<typeof import("./queue").Queue>;

beforeAll(async () => {
  process.env.CORKBOARD_CLOUD = `http://localhost:${server.port}`;
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.CORKBOARD_STATE_DIR = join(dir, "state/corkboard");
  process.env.CORKBOARD_FLEET_STATE = join(dir, "fleet");
  process.env.CORKBOARD_FLEET_MANIFEST = join(dir, "fleet.json");
  process.env.CORKBOARD_FLEET_ENVIRONMENT = "local";
  mkdirSync(join(dir, "state/corkboard"), { recursive: true });
  writeFileSync(
    join(dir, "state/corkboard/auth.json"),
    JSON.stringify({ cloud: process.env.CORKBOARD_CLOUD, client_id: "c", access_token: "owner", refresh_token: "r", expires_at: Date.now() + 3600_000 }),
  );
  writeFileSync(
    process.env.CORKBOARD_FLEET_MANIFEST,
    JSON.stringify({
      flake: "",
      owner: "matthew",
      memoryBudget: null,
      slots: {
        "agent-0": { guestAddress: "", stateDir: "", shareDir: "", outboxDir: "", unit: "agent-0.service", network: { address: null, egress: "allowlist", allowedDomains: ["api.anthropic.com"], allowedDomainSuffixes: [], routedEgress: [] } },
      },
      residents: {},
      templates: {
        coding: { memory: 4096, cores: 2, needsApproval: false, capNames: ["coding"] },
      },
      bindings: { work: { shares: ["vault"] } },
      defaultAccount: "personal",
    }),
  );
  // A repo with a commit, and a bundle of one more on top, as a slot hands back.
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("checkout", "-q", "-b", "fleet-result");
  git("commit", "-q", "--allow-empty", "-m", "the fix");
  git("bundle", "create", "-q", join(dir, "work.bundle"), "main..fleet-result");
  git("checkout", "-q", "main");
  git("branch", "-q", "-D", "fleet-result");

  fleet = await import("./fleet");
  // Paths are read at import: never let a module loaded earlier point this
  // at the real state.
  if (!fleet.SPAWNS.startsWith(dir) || !(await import("../../bridge/cloud")).CLOUD.includes(String(server.port))) throw new Error("fleet's paths aren't the test's");
  queue = new (await import("./queue")).Queue();
});
afterAll(() => server.stop(true));

const add = (s: Partial<Remote> & { id: string }) =>
  remote.push({ template: "coding", task: "fix it", by: "user", state: "queued", environment: "local", board: "fleet", card: "TASK-1", agent: `coding-${s.id}`, ...s });

test("says what it runs, and claims what's queued for it as a spawn of its own", async () => {
  add({ id: "aaaaaa1", board: "proj" });
  add({ id: "aaaaaa2", template: "coding", by: "pepper", account: "personal" });
  add({ id: "aaaaaa3", state: "pending-approval" });
  add({ id: "aaaaaa4", brain: "work", account: "work" });
  add({ id: "aaaaaa5", board: null, card: null });
  await queue.step(new Set());
  expect(Object.keys(environment.templates)).toEqual(["coding"]);
  expect(environment).toMatchObject({ egress: { open: false, domains: ["api.anthropic.com"], suffixes: [] }, bindings: ["work"], jobs: ["consolidate"] });
  expect(environment.running).toMatchObject({ budget: null, used: 0, residents: [], slots: [{ name: "agent-0", spawn: null }], host: { name: expect.any(String) } });
  const a = fleet.read("aaaaaa1")!;
  expect(a).toMatchObject({ state: "queued", by: "user", account: "personal", repo, remote: { board: "proj", card: "TASK-1", agent: "coding-aaaaaa1", token: "cbc_aaaaaa1" } });
  // Each runs as the account the Worker stamped it with.
  expect(fleet.read("aaaaaa2")).toMatchObject({ by: "pepper", account: "personal" });
  expect(fleet.read("aaaaaa2")!.repo).toBeUndefined();
  expect(fleet.read("aaaaaa3")).toBeUndefined();
  // A brain's has the brain's token.
  expect(fleet.read("aaaaaa4")).toMatchObject({ brain: "work", account: "work", remote: { token: "cbc_aaaaaa4", brainToken: "cbb_aaaaaa4", secrets: { github: "ghp_x" } } });
  expect(fleet.read("aaaaaa1")!.remote!.brainToken).toBeUndefined();
  // One on no board has no token, and nothing to say it's on one.
  expect(fleet.read("aaaaaa5")).toMatchObject({ remote: { board: null, card: null, token: null } });
});

test("passes a stop on, and reports a run, fetching its commits and revoking its token at the end", async () => {
  const a = fleet.read("aaaaaa1")!;
  fleet.write({ ...a, state: "running", slot: "agent-0" });
  remote[0].stopRequested = false;
  await queue.step();
  expect(calls.at(-1)).toMatchObject({ path: "/api/spawns/aaaaaa1/report", body: { state: "running", slot: "agent-0" } });
  expect(fleet.read("aaaaaa1")!.reported).toBe("running");

  // A stop asked for in the Worker reaches the spawn here, on the next look.
  fleet.write({ ...fleet.read("aaaaaa2")!, state: "running", slot: "agent-1" });
  remote[1].state = "running";
  remote[1].stopRequested = true;
  (queue as any).dirty = true;
  await queue.step();
  expect(fleet.read("aaaaaa2")!.stopRequested).toBe(true);

  // It ends: the commits come back as fleet/<id>, the answer goes up, and the token is revoked.
  mkdirSync(join(fleet.SPAWNS, "aaaaaa1"), { recursive: true });
  writeFileSync(join(fleet.SPAWNS, "aaaaaa1/result.json"), JSON.stringify({ result: "Fixed." }));
  Bun.spawnSync(["cp", join(dir, "work.bundle"), join(fleet.SPAWNS, "aaaaaa1/work.bundle")]);
  fleet.write({ ...fleet.read("aaaaaa1")!, state: "done", exit: 0 });
  calls.length = 0;
  await queue.step();
  const report = calls.find((c) => c.path === "/api/spawns/aaaaaa1/report")!;
  expect(report.body).toMatchObject({ state: "done", exit: 0 });
  expect(report.body.result).toBe(`Fixed.\n\nIts commits: branch fleet/aaaaaa1 in ${repo}.`);
  expect(calls.find((c) => c.path === "/api/tokens/revoke")?.body).toEqual({ token: "cbc_aaaaaa1" });
  expect(fleet.read("aaaaaa1")).toMatchObject({ reported: "done", fetched: "fleet/aaaaaa1", remote: { token: null } });
  const log = Bun.spawnSync(["git", "-C", repo, "log", "--format=%s", "fleet/aaaaaa1"]).stdout.toString();
  expect(log).toBe("the fix\nbase\n");

  // A brain's revokes both its tokens.
  fleet.write({ ...fleet.read("aaaaaa4")!, state: "failed", error: "x" });
  calls.length = 0;
  await queue.step();
  expect(calls.filter((c) => c.path === "/api/tokens/revoke").map((c) => c.body.token)).toEqual(["cbc_aaaaaa4", "cbb_aaaaaa4"]);
  expect(fleet.read("aaaaaa4")!.remote).toMatchObject({ token: null, brainToken: "" });
  expect(fleet.read("aaaaaa4")!.remote!.secrets).toBeUndefined();

  // Nothing new, nothing said.
  calls.length = 0;
  await queue.step();
  expect(calls.filter((c) => c.path.includes("/report"))).toEqual([]);
});
