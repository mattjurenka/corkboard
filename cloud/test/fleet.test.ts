import { env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "../src/fleet";
import { ownerToken, worker } from "./login";

const BOARD = "home-matthew-corkboard";
const USER = "sub-me@example.com";
let owner: string;

const call = (token: string, method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const send = async (method: string, path: string, body?: unknown) => {
  const res = await call(owner, method, path, body);
  return { status: res.status, body: await res.json<any>().catch(() => null) };
};

let rpcId = 0;
async function tool(token: string, name: string, args: object = {}) {
  const res = await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  const body = await res.json<any>();
  const text = body.result.content[0].text;
  return body.result.isError ? { error: text } : JSON.parse(text);
}
async function tools(token: string) {
  const res = await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method: "tools/list" });
  return (await res.json<any>()).result.tools.map((t: any) => t.name) as string[];
}

const TEMPLATES = {
  coding: { needsApproval: false, memory: 4096, cores: 2, capNames: ["coding"] },
};
// What every slot in local may reach: Pepper's hosts, and Microsoft's.
const EGRESS = { open: false, domains: ["portal.corkboard.fyi", "oauth2.googleapis.com", "www.googleapis.com", "gmail.googleapis.com"], suffixes: ["microsoft.com"] };
const WORK = { name: "work", title: "Stable", account: "work", credentials: ["graph"] };

beforeEach(async () => {
  owner = await ownerToken();
  await send("PUT", `/api/boards/${BOARD}`, { name: "corkboard", root: "/home/matthew/corkboard" });
  expect((await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES, egress: EGRESS, bindings: ["work"] })).status).toBe(200);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const card = async (board: string, id: string) => (await send("GET", `/api/boards/${board}/cards/${id}`)).body;

describe("spawning", () => {
  it("queues the user's spawn with a card on the Fleet board", async () => {
    const { status, body: s } = await send("POST", "/api/spawns", { template: "coding", task: "Run the tests\n\nand fix what fails" });
    expect(status).toBe(201);
    expect(s).toMatchObject({ template: "coding", environment: "local", state: "queued", by: "user", brain: null, board: "fleet" });
    const c = await card("fleet", s.card);
    expect(c).toMatchObject({ title: "Run the tests", status: "ready", agent: s.agent, agent_state: "queued", labels: ["fleet"], attention: null });
    expect(c.description).toContain("and fix what fails");
    const boards = (await send("GET", "/api/boards")).body;
    expect(boards.map((b: any) => b.key)).toContain("fleet");
  });

  it("refuses a template no environment runs, and a board that doesn't exist", async () => {
    expect((await send("POST", "/api/spawns", { template: "valheim", task: "x" })).body.error).toBe("no environment runs valheim; there are coding");
    expect((await send("POST", "/api/spawns", { template: "coding", task: "x", environment: "cloud" })).status).toBe(400);
    expect((await send("POST", "/api/spawns", { template: "coding", task: "x", board: "nope" })).status).toBe(400);
    expect((await send("POST", "/api/spawns", { template: "coding", task: " " })).status).toBe(400);
  });

  it("hides a template an old fleetd still says is a brain's", async () => {
    const old = { ...TEMPLATES, "work-coding": { brain: "work", needsApproval: true, memory: 4096, cores: 2, capNames: ["coding"] } };
    const { body } = await send("PUT", "/api/fleet/environments/local", { templates: old });
    expect(Object.keys(body.templates)).toEqual(["coding"]);
    expect((await send("POST", "/api/spawns", { template: "work-coding", task: "x" })).status).toBe(400);
  });

  it("works for a brain, stamped from its record", async () => {
    expect((await send("POST", "/api/brains", WORK)).status).toBe(201);
    const { status, body: s } = await send("POST", "/api/spawns", { template: "coding", brain: "work", task: "file the notes" });
    expect(status).toBe(201);
    // The user's own runs at once, as the brain's account.
    expect(s).toMatchObject({ state: "queued", by: "user", brain: "work", account: "work" });
    expect((await card("fleet", s.card)).description).toContain("coding for the work brain in local, asked by user");
    expect((await send("POST", "/api/spawns", { task: "x", brain: "work" })).body).toMatchObject({ template: "coding", brain: "work" });
    expect((await send("POST", "/api/spawns", { task: "x" })).body).toMatchObject({ brain: null, account: null });
  });

  it("refuses a brain there isn't, or that's archived, and a shell beside one", async () => {
    expect((await send("POST", "/api/spawns", { template: "coding", brain: "nobody", task: "x" })).body.error).toContain("no brain nobody");
    expect((await send("POST", "/api/spawns", { template: "coding", brain: "Not A Name", task: "x" })).status).toBe(400);
    await send("POST", "/api/brains", WORK);
    await send("DELETE", "/api/brains/work");
    expect((await send("POST", "/api/spawns", { template: "coding", brain: "work", task: "x" })).body.error).toContain("no brain work");
    expect((await send("POST", "/api/spawns", { template: "coding", brain: "pepper", task: "x", packages: ["jq"] })).body.error).toContain("for no brain");
  });

  it("lets a brain spawn for itself or for no brain, and holds one that holds credentials", async () => {
    await send("POST", "/api/brains", WORK);
    await expect(spawn(env as any, USER, "pepper", { template: "coding", brain: "work", task: "x" })).rejects.toThrow("for itself or for no brain");
    // Brainless, it runs at once, as the spawning brain's account.
    const free = await spawn(env as any, USER, "pepper", { template: "coding", task: "x" });
    expect(free).toMatchObject({ state: "queued", brain: null, account: "personal" });
    const held = await spawn(env as any, USER, "pepper", { template: "coding", brain: "pepper", task: "read my mail" });
    expect(held).toMatchObject({ state: "pending-approval", brain: "pepper", by: "pepper", account: "personal" });
    expect((await card("fleet", held.card)).attention).toBe("approve: pepper wants to spawn coding for the pepper brain, which holds corkboard, google");

    // Claiming waits for the approval, which clears the card's attention.
    expect((await send("POST", `/api/spawns/${held.id}/claim`, { environment: "local" })).status).toBe(409);
    const approved = await send("POST", `/api/spawns/${held.id}/approve`);
    expect(approved.body.state).toBe("queued");
    expect((await card("fleet", held.card)).attention).toBe(null);
    expect((await send("POST", `/api/spawns/${held.id}/approve`)).status).toBe(409);
  });
});

describe("bringing your own VM", () => {
  beforeEach(async () => {
    const templates = { ...TEMPLATES, gpu: { needsApproval: false, memory: 8192, cores: 4, capNames: ["coding", "gpu"] } };
    await send("PUT", "/api/fleet/environments/local", { templates, offer: { memory: 16384, cores: 6 } });
  });

  it("picks the smallest template with every need, and keeps the shell and size", async () => {
    const plain = (await send("POST", "/api/spawns", { task: "x", packages: ["ffmpeg", "python3Packages.numpy"] })).body;
    expect(plain).toMatchObject({ template: "coding", environment: "local", shell: { packages: ["ffmpeg", "python3Packages.numpy"] } });
    const gpu = (await send("POST", "/api/spawns", { task: "x", needs: ["gpu"], shell: "github:me/envs#cuda", memory: 12000, cores: 2 })).body;
    // Never smaller than the template.
    expect(gpu).toMatchObject({ template: "gpu", shell: { flake: "github:me/envs#cuda" }, memory: 12000, cores: 4 });
    expect((await card("fleet", gpu.card)).description).toContain("gpu in local, with github:me/envs#cuda");
  });

  it("refuses what no host offers, a bad shell, and a shell beside a brain", async () => {
    expect((await send("POST", "/api/spawns", { task: "x", needs: ["valheim"] })).body.error).toContain("has a VM with valheim; there are coding, gpu");
    expect((await send("POST", "/api/spawns", { task: "x", memory: 32768 })).body.error).toContain("local gives at most 16384 MiB, 6 cores");
    expect((await send("POST", "/api/spawns", { task: "x", packages: ["a; rm -rf /"] })).status).toBe(400);
    expect((await send("POST", "/api/spawns", { task: "x", shell: "x y" })).status).toBe(400);
    expect((await send("POST", "/api/spawns", { brain: "pepper", task: "x", packages: ["jq"] })).body.error).toContain("for no brain");
  });

  it("from MCP", async () => {
    const s = await tool(owner, "spawn_agent", { task: "render it", needs: ["gpu"], packages: ["blender"] });
    expect(s).toMatchObject({ template: "gpu", shell: { packages: ["blender"] } });
    expect((await tool(owner, "spawn_status")).environments[0].offer).toEqual({ memory: 16384, cores: 6 });
  });
});

describe("sessions", () => {
  it("queues an interactive spawn without a task, named for its template", async () => {
    const s = await send("POST", "/api/spawns", { template: "coding", interactive: true, board: BOARD });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ interactive: true, task: "", state: "queued", board: BOARD });
    expect((await tool(owner, "read_card", { board: BOARD, id: s.body.card })).title).toBe("coding session");
    expect((await send("POST", "/api/spawns", { template: "coding" })).status).toBe(400);
  });

  it("starts one from MCP, its first message the task", async () => {
    const s = await tool(owner, "start_session", { template: "coding", board: BOARD, message: "look at the flaky test" });
    expect(s).toMatchObject({ interactive: true, task: "look at the flaky test", state: "queued", board: BOARD });
  });
});

describe("environments", () => {
  it("forgets one no fleetd runs as any more", async () => {
    const del = (name: string) => send("DELETE", `/api/fleet/environments/${name}`);
    expect((await del("local")).status).toBe(204);
    expect((await send("GET", "/api/fleet/environments")).body.map((e: { name: string }) => e.name)).not.toContain("local");
    expect((await del("local")).status).toBe(404);
  });
});

describe("fleetd's side", () => {
  it("works in the claiming environment's own clone of the board's project", async () => {
    await send("PUT", `/api/boards/${BOARD}`, { root: "/srv/corkboard", environment: "local" });
    const s = (await send("POST", "/api/spawns", { template: "coding", task: "fix it", board: BOARD })).body;
    expect((await send("POST", `/api/spawns/${s.id}/claim`, { environment: "local" })).body.repo).toBe("/srv/corkboard");
  });

  it("claims a spawn for a card token and the board's repo, runs it, and leaves the answer on the card", async () => {
    const s = (await send("POST", "/api/spawns", { template: "coding", task: "fix it", board: BOARD })).body;
    expect((await send("POST", `/api/spawns/${s.id}/claim`, { environment: "cloud" })).status).toBe(409);
    const claimed = await send("POST", `/api/spawns/${s.id}/claim`, { environment: "local" });
    expect(claimed.status).toBe(200);
    expect(claimed.body.repo).toBe("/home/matthew/corkboard");
    expect(claimed.body.spawn.claimed).toBeTruthy();

    // The spawn token works on its own card, as the agent named on it.
    const token = claimed.body.token as string;
    expect(await tools(token)).not.toContain("spawn_agent");
    expect(await tool(token, "claim_card", { id: s.card })).toMatchObject({ agent: s.agent, agent_state: "working" });

    expect((await send("POST", `/api/spawns/${s.id}/report`, { state: "running", slot: "agent-0" })).body).toMatchObject({ state: "running", slot: "agent-0" });
    // Saying it again changes nothing; going back is refused.
    expect((await send("POST", `/api/spawns/${s.id}/report`, { state: "running" })).status).toBe(200);
    expect((await send("POST", `/api/spawns/${s.id}/claim`, { environment: "local" })).status).toBe(409);
    const done = await send("POST", `/api/spawns/${s.id}/report`, { state: "done", exit: 0, result: "Fixed the off-by-one." });
    expect(done.body).toMatchObject({ state: "done", exit: 0, result: "Fixed the off-by-one." });
    expect((await send("POST", `/api/spawns/${s.id}/report`, { state: "failed" })).status).toBe(409);

    const c = await card(BOARD, s.card);
    expect(c).toMatchObject({ status: "review", agent_state: "needs-review" });
    expect(c.log.map((e: any) => e.note)).toEqual(expect.arrayContaining(["running in agent-0 (local)", "done:\nFixed the off-by-one."]));
  });

  it("hands a brain's spawn a token for the brain, which its memory hooks send", async () => {
    await send("POST", "/api/brains", WORK);
    const s = (await send("POST", "/api/spawns", { template: "coding", brain: "work", task: "file the notes" })).body;
    const claimed = (await send("POST", `/api/spawns/${s.id}/claim`, { environment: "local" })).body;
    expect(claimed.brainToken).toMatch(/^cbc_/);
    expect(await (await call(claimed.brainToken, "GET", "/memory/context")).text()).toMatch(/^# Memory: work/);
    // A brainless one gets none.
    const plain = (await send("POST", "/api/spawns", { template: "coding", task: "x" })).body;
    expect((await send("POST", `/api/spawns/${plain.id}/claim`, { environment: "local" })).body.brainToken).toBeUndefined();
  });

  it("fails a brain's spawn whose brain was archived before it was claimed", async () => {
    await send("POST", "/api/brains", WORK);
    const s = (await send("POST", "/api/spawns", { template: "coding", brain: "work", task: "x" })).body;
    await send("DELETE", "/api/brains/work");
    expect((await send("POST", `/api/spawns/${s.id}/claim`, { environment: "local" })).status).toBe(409);
    expect((await send("GET", `/api/spawns/${s.id}`)).body).toMatchObject({ state: "failed", error: "the work brain is archived or gone" });
    expect((await card("fleet", s.card)).attention).toBe("spawn failed: the work brain is archived or gone");
  });

  it("raises a failure on the card", async () => {
    const s = (await send("POST", "/api/spawns", { template: "coding", task: "fix it" })).body;
    await send("POST", `/api/spawns/${s.id}/claim`, { environment: "local" });
    await send("POST", `/api/spawns/${s.id}/report`, { state: "running" });
    await send("POST", `/api/spawns/${s.id}/report`, { state: "failed", exit: 1, error: "the slot stopped without finishing" });
    expect((await card("fleet", s.card)).attention).toBe("spawn failed: the slot stopped without finishing");
  });

  it("stops a queued spawn at once, and a running one by asking fleetd", async () => {
    const a = (await send("POST", "/api/spawns", { template: "coding", task: "a" })).body;
    expect((await send("POST", `/api/spawns/${a.id}/stop`)).body.state).toBe("stopped");
    const b = (await send("POST", "/api/spawns", { template: "coding", task: "b" })).body;
    await send("POST", `/api/spawns/${b.id}/claim`, { environment: "local" });
    await send("POST", `/api/spawns/${b.id}/report`, { state: "running" });
    expect((await send("POST", `/api/spawns/${b.id}/stop`)).body).toMatchObject({ state: "running", stopRequested: true });
    expect((await send("POST", `/api/spawns/${b.id}/report`, { state: "stopped" })).body.state).toBe("stopped");
  });

  it("lists by environment and state, newest first", async () => {
    const a = (await send("POST", "/api/spawns", { template: "coding", task: "a" })).body;
    const b = (await send("POST", "/api/spawns", { template: "coding", task: "b" })).body;
    await send("POST", `/api/spawns/${a.id}/stop`);
    expect((await send("GET", "/api/spawns?environment=local&state=queued")).body.map((s: any) => s.id)).toEqual([b.id]);
    expect((await send("GET", "/api/spawns")).body.map((s: any) => s.id)).toEqual([b.id, a.id]);
    expect((await send("GET", "/api/spawns?state=bogus")).status).toBe(400);
  });

  it("is the owner's: a card token can't reach it", async () => {
    const s = (await send("POST", "/api/spawns", { template: "coding", task: "a" })).body;
    const { token } = (await send("POST", `/api/spawns/${s.id}/claim`, { environment: "local" })).body;
    expect((await call(token, "GET", "/api/spawns")).status).toBe(403);
  });
});

describe("what's running", () => {
  const RUNNING = {
    budget: 21504,
    used: 20992,
    residents: [{ name: "brain-vm", brain: "work", memory: 14336, up: true }, { name: "pepper-vm", brain: "pepper", memory: 2048, up: false }],
    slots: [{ name: "agent-0", spawn: "abc123def", template: "coding", brain: "work", memory: 4608 }, { name: "agent-1", spawn: null, template: null, memory: null }],
  };

  it("is kept as fleetd last said, through a look that doesn't say", async () => {
    expect((await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES, running: RUNNING })).status).toBe(200);
    expect((await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES })).status).toBe(200);
    const [local] = (await send("GET", "/api/fleet/environments")).body;
    expect(local.running).toEqual(RUNNING);
    expect((await tool(owner, "spawn_status")).environments[0].running).toEqual(RUNNING);
  });

  it("keeps each VM's config, cut to size", async () => {
    const network = { address: "10.80.0.2", egress: "allowlist", allowedDomains: ["api.anthropic.com", 7], allowedDomainSuffixes: [], routedEgress: [] };
    const config = { ...network, cores: 2, capabilities: ["claude-code", "coding"], account: "../x", needsApproval: false };
    const running = { ...RUNNING, slots: [{ ...RUNNING.slots[0], config }, { ...RUNNING.slots[1], config: "no" }] };
    const { body } = await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES, running });
    expect(body.running.slots[0].config).toEqual({ ...config, allowedDomains: ["api.anthropic.com"], account: null });
    expect(body.running.slots[1].config).toBeUndefined();
  });

  it("keeps the machine fleetd runs on", async () => {
    const host = { name: "valheim-jurenka-nyc", os: "Ubuntu 24.04.5 LTS", cores: 2, memory: 3915, available: 1800, load: [0.2, 0.3, 0.3, 9], uptime: 100, junk: 1 };
    const { body } = await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES, running: { ...RUNNING, host } });
    expect(body.running.host).toEqual({ name: host.name, os: host.os, cores: 2, memory: 3915, available: 1800, load: [0.2, 0.3, 0.3], uptime: 100 });
  });

  it("drops what isn't a name", async () => {
    const running = { ...RUNNING, residents: [{ name: "../x", up: true }, ...RUNNING.residents] };
    const { body } = await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES, running });
    expect(body.running.residents.map((r: any) => r.name)).toEqual(["brain-vm", "pepper-vm"]);
    expect((await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES, running: [] })).status).toBe(400);
  });
});

describe("the MCP tools", () => {
  it("spawn and report for the user's clients, and aren't Pepper's yet", async () => {
    const s = await tool(owner, "spawn_agent", { template: "coding", task: "look into the flaky test", board: BOARD });
    expect(s).toMatchObject({ state: "queued", by: "user", board: BOARD });
    const st = await tool(owner, "spawn_status");
    expect(st.environments[0].templates.map((t: any) => t.name)).toEqual(["coding"]);
    expect(st.environments[0]).toMatchObject({ egress: EGRESS, bindings: ["work"] });
    expect(st.brains).toEqual([{ name: "pepper", title: "Pepper", account: "personal", holdsCredentials: true }]);
    expect(st.spawns[0].id).toBe(s.id);
    expect((await tool(owner, "spawn_status", { id: s.id })).card).toBe(s.card);
    expect((await tool(owner, "spawn_status", { id: "nope000" })).error).toContain("no spawn");
    expect((await tool(owner, "spawn_stop", { id: s.id })).state).toBe("stopped");

    const pepper = (await (await call(owner, "POST", "/api/brains/pepper/tokens", {})).json<any>()).token as string;
    expect(await tools(pepper)).not.toContain("spawn_agent");
    expect(await tools(owner)).toEqual(expect.arrayContaining(["spawn_agent", "spawn_status", "spawn_stop"]));
  });

  it("spawn for a brain", async () => {
    await send("POST", "/api/brains", WORK);
    expect(await tool(owner, "spawn_agent", { brain: "work", task: "file the notes" })).toMatchObject({ template: "coding", brain: "work", account: "work" });
    expect(await tool(owner, "start_session", { brain: "work", board: BOARD })).toMatchObject({ interactive: true, brain: "work" });
  });
});
