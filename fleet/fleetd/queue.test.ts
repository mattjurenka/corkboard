// fleetd's side of the Worker's queue, against a stand-in Worker: what it
// claims, what it passes on, and what it reports; and, against a stand-in
// node, what it asks the node for and writes on its cards.   bun test fleet/fleetd
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  node?: true;
  sealed?: true;
  shell?: unknown;
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
    if (m![2] === "claim" && s.sealed) return Response.json({ spawn: s, token: null, repo: null, holds: ["google"] });
    if (m![2] === "claim") return Response.json({ spawn: s, token: s.board && !s.node ? `cbc_${s.id}` : null, repo: s.board === "proj" ? repo : null, ...(s.brain && { brainToken: `cbb_${s.id}`, secrets: { github: "ghp_x" } }) });
    s.state = body.state;
    return Response.json(s);
  },
});

// The node: its cards, the grants it hands out, and those ended; and its
// fleet object's sealed spawns and manifests.
const cards: Record<string, any> = {};
const words: Record<string, any> = {};
const manifests: Record<string, any> = {};
const grants: any[] = [];
const revoked: string[] = [];
const gitRevoked: string[] = [];
const nodeCalls: { method: string; path: string; body: any }[] = [];
const node = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    nodeCalls.push({ method: req.method, path: url.pathname, body });
    if (req.headers.get("authorization") !== "Bearer nodeowner") return Response.json({ error: "who?" }, { status: 401 });
    const p = url.pathname.replace(/^\/api\/node/, "");
    if (p === "/grants" && req.method === "POST") {
      grants.push(body);
      const token = `cbn_${body.scope}_${body.card ?? body.brain ?? body.spawn}`;
      return Response.json(body.scope === "brain" ? { token, url: url.origin } : { token, expires_at: "x", url: `${url.origin}/mcp` });
    }
    if (p === "/grants" && req.method === "DELETE") return Response.json({ revoked: revoked.push(body.token) > 0 });
    const ungit = p.match(/^\/fleet\/spawns\/(\w+)\/git$/);
    if (ungit && req.method === "DELETE") return (gitRevoked.push(ungit[1]), new Response(null, { status: 204 }));
    const f = p.match(/^\/fleet\/(spawns|environments)\/(\w+)$/);
    if (f?.[1] === "environments" && req.method === "PUT") return Response.json((manifests[f[2]] = body.manifest), { status: 200 });
    if (f?.[1] === "spawns" && req.method === "PUT") return Response.json(Object.assign(words[f[2]], body));
    if (f?.[1] === "spawns") {
      const w = words[f[2]];
      if (!w) return Response.json({ error: "no spawn here" }, { status: 404 });
      const holds = url.searchParams.get("holds")?.split(",") ?? [];
      const key = url.searchParams.get("git");
      const git = key && { account: "acct", gate: "https://git.test", chain: { cert: {}, grants: [{ body: { holder: key, repos: "matt/corkboard", perms: "contents:write", refs: null } }] }, environment: url.searchParams.get("environment") === "local" ? undefined : "wrong" };
      return Response.json({ ...w, ...(holds.includes("google") && { secrets: { google: "refresh" } }), ...(git && { git }) });
    }
    if (p === "/boards/mine") return Response.json({ key: "mine", root: "/nowhere", roots: { local: repo } });
    const m = p.match(/^\/boards\/mine\/cards\/([\w-]+)(\/log)?$/);
    const c = m && cards[m[1]];
    if (!c) return Response.json({ error: "no" }, { status: 404 });
    if (m![2]) c.log.push(body.note);
    else if (req.method === "PATCH") Object.assign(c, body);
    return Response.json(c);
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
  writeFileSync(join(dir, "node-token"), "nodeowner\n");
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
      node: { url: `http://localhost:${node.port}`, tokenFile: join(dir, "node-token") },
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
afterAll(() => {
  server.stop(true);
  node.stop(true);
});

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

test("equips one on the node's board from the node, and writes how it goes on its card there", async () => {
  cards["TASK-9"] = { id: "TASK-9", status: "backlog", agent: "coding-bbbbbb1", agent_state: "queued", attention: "approve: coding for work", log: [] };
  cards["TASK-8"] = { id: "TASK-8", status: "backlog", agent: "coding-bbbbbb2", agent_state: "queued", attention: "approve: coding for work", log: [] };
  add({ id: "bbbbbb1", board: "mine", card: "TASK-9", node: true, brain: "work", account: "work" });
  add({ id: "bbbbbb2", board: "mine", card: "TASK-8", node: true, state: "stopped" });
  (queue as any).dirty = true;
  calls.length = 0;
  await queue.step();

  // Its grant, repo (the board's root here) and memory are the node's; the
  // Worker's brain token is given back; the approval is over.
  expect(grants).toEqual([
    { scope: "card", board: "mine", card: "TASK-9", agent: "coding-bbbbbb1" },
    { scope: "brain", brain: "work", agent: "coding-bbbbbb1" },
  ]);
  const node$ = `http://localhost:${node.port}`;
  expect(fleet.read("bbbbbb1")).toMatchObject({ state: "queued", repo, remote: { node: true, token: "cbn_card_TASK-9", mcp: `${node$}/mcp`, brainToken: "cbn_brain_work", memory: node$ } });
  expect(calls.find((c) => c.path === "/api/tokens/revoke")?.body).toEqual({ token: "cbb_bbbbbb1" });
  expect(cards["TASK-9"]).toMatchObject({ attention: null, log: ["approved"] });

  // One stopped before it was claimed lets go of its card, and is over here.
  expect(cards["TASK-8"]).toMatchObject({ agent: null, agent_state: null, attention: null, status: "backlog", log: ["stopped before it ran"] });
  expect(fleet.read("bbbbbb2")).toMatchObject({ state: "stopped", reported: "stopped", carded: "stopped" });

  // Running, then done: each said once on the card, and the node's tokens
  // ended through the node.
  fleet.write({ ...fleet.read("bbbbbb1")!, state: "running", slot: "agent-0" });
  await queue.step();
  await queue.step();
  expect(cards["TASK-9"].log).toEqual(["approved", "running in agent-0 (local)"]);
  expect(fleet.read("bbbbbb1")).toMatchObject({ reported: "running", carded: "running" });

  mkdirSync(join(fleet.SPAWNS, "bbbbbb1"), { recursive: true });
  writeFileSync(join(fleet.SPAWNS, "bbbbbb1/result.json"), JSON.stringify({ result: "Done it." }));
  fleet.write({ ...fleet.read("bbbbbb1")!, state: "done", exit: 0 });
  calls.length = 0;
  await queue.step();
  expect(cards["TASK-9"]).toMatchObject({ status: "review", agent_state: "needs-review" });
  expect(cards["TASK-9"].log.at(-1)).toBe("done:\nDone it.");
  expect(revoked).toEqual(["cbn_card_TASK-9", "cbn_brain_work"]);
  expect(calls.filter((c) => c.path === "/api/tokens/revoke")).toEqual([]);
  expect(fleet.read("bbbbbb1")).toMatchObject({ reported: "done", carded: "done", remote: { token: null, brainToken: "" } });

  // A stopped one leaves the card as the agent left it, but lets go of it.
  cards["TASK-7"] = { id: "TASK-7", status: "doing", agent: "coding-bbbbbb3", agent_state: "working", log: [] };
  add({ id: "bbbbbb3", board: "mine", card: "TASK-7", node: true });
  (queue as any).dirty = true;
  await queue.step();
  fleet.write({ ...fleet.read("bbbbbb3")!, state: "stopped" });
  await queue.step();
  expect(cards["TASK-7"]).toMatchObject({ status: "doing", agent: null, agent_state: null, log: ["stopped"] });
});

test("with a device on the node, keeps the environment and a sealed spawn's words there", async () => {
  // fleetd's relay-only device, whose channel here is the stand-in node's
  // HTTP as its owner.
  const { certify, newDevice } = await import("../../lib/e2ee/device");
  const { accountKeys, newRoot } = await import("../../lib/e2ee/keys");
  const { makeDevice, setOpener, storeCert } = await import("./node");
  const keys = accountKeys(newRoot());
  const file = join(dir, "fleet-device.json");
  const d = makeDevice(file);
  storeCert(file, certify(keys, d, "fleetd", Date.now(), "relay"));
  setOpener(file, {
    nodes: async () => ({ leader: "n", connected: [{ device: "n", since: 0 }], handle: "h", url: "" }),
    channel: async () =>
      ({
        open: true,
        closed: new Promise(() => {}),
        fetch: (path: string, init: RequestInit = {}) => {
          const headers = new Headers(init.headers);
          headers.set("Authorization", "Bearer nodeowner");
          return fetch(`http://localhost:${node.port}${path}`, { ...init, headers });
        },
      }) as any,
  });
  const m = JSON.parse(readFileSync(process.env.CORKBOARD_FLEET_MANIFEST!, "utf8"));
  writeFileSync(process.env.CORKBOARD_FLEET_MANIFEST!, JSON.stringify({ ...m, node: { url: "", device: file } }));

  // One whose words the node hasn't got yet stays claimed there, unwritten here.
  add({ id: "cccccc1", task: "", board: null, card: null, sealed: true });
  add({ id: "cccccc2", task: "", board: null, card: null, sealed: true, brain: "work" });
  (queue as any).dirty = true;
  await queue.step(new Set());
  // The Worker has the templates but not the egress or what runs; the node has it all.
  expect(environment).toMatchObject({ sealed: true, templates: { coding: expect.anything() }, bindings: ["work"] });
  expect(environment.egress).toBeUndefined();
  expect(environment.running).toBeUndefined();
  expect(manifests.local).toMatchObject({ egress: { open: false, domains: ["api.anthropic.com"] }, running: { slots: [{ name: "agent-0" }] } });
  expect(fleet.read("cccccc1")).toBeUndefined();

  // Once it has them: the task, the shell and the secrets of what it holds.
  words.cccccc1 = { task: "read the mail", shell: { packages: ["jq"] }, result: null, error: null };
  words.cccccc2 = { task: "x", shell: { flake: ".#dev" }, result: null, error: null };
  (queue as any).dirty = true;
  await queue.step();
  expect(fleet.read("cccccc1")).toMatchObject({ task: "read the mail", shell: { packages: ["jq"] }, remote: { sealed: true, secrets: { google: "refresh" } } });
  // A shell beside a brain, which the Worker couldn't see, is refused here.
  expect(fleet.read("cccccc2")).toMatchObject({ state: "failed", error: expect.stringContaining("never goes beside the work brain's memory") });

  // Its answer goes to the node; the Worker hears its state only.
  mkdirSync(join(fleet.SPAWNS, "cccccc1"), { recursive: true });
  writeFileSync(join(fleet.SPAWNS, "cccccc1/result.json"), JSON.stringify({ result: "Three replies sent." }));
  fleet.write({ ...fleet.read("cccccc1")!, state: "done", exit: 0 });
  calls.length = 0;
  await queue.step();
  const report = calls.find((c) => c.path === "/api/spawns/cccccc1/report")!;
  expect(report.body).toEqual({ state: "done", exit: 0 });
  expect(words.cccccc1.result).toBe("Three replies sent.");
  expect(fleet.read("cccccc1")!.remote!.secrets).toBeUndefined();
  expect(calls.find((c) => c.path === "/api/spawns/cccccc2/report")!.body).toEqual({ state: "failed" });
  expect(words.cccccc2.error).toContain("never goes beside");
});

test("a template that names repos gets a key of its own, which the node signs a grant to, taken back at the end", async () => {
  const m = JSON.parse(readFileSync(process.env.CORKBOARD_FLEET_MANIFEST!, "utf8"));
  m.templates.pusher = { memory: 1024, cores: 1, needsApproval: true, capNames: [], git: { repos: ["matt/corkboard"], permissions: { contents: "write" } } };
  writeFileSync(process.env.CORKBOARD_FLEET_MANIFEST!, JSON.stringify(m));
  add({ id: "dddddd1", template: "pusher", task: "", board: null, card: null, sealed: true });
  add({ id: "dddddd2", task: "", board: null, card: null, sealed: true });
  words.dddddd1 = { task: "push it", shell: null, result: null, error: null };
  words.dddddd2 = { task: "don't", shell: null, result: null, error: null };
  (queue as any).dirty = true;
  await queue.step();
  const git = fleet.read("dddddd1")!.remote!.git!;
  const { signerOf } = await import("./forge");
  expect(git.chain.grants![0].body.holder).toBe(signerOf(git).id);
  // Asked for this environment.
  expect((git as any).environment).toBeUndefined();
  expect(fleet.read("dddddd2")!.remote!.git).toBeUndefined();
  fleet.write({ ...fleet.read("dddddd1")!, state: "done", exit: 0 });
  await queue.step();
  expect(gitRevoked).toEqual(["dddddd1"]);
  expect(fleet.read("dddddd1")!.remote!.git).toBeUndefined();
});
