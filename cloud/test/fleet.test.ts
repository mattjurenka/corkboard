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
  coding: { brain: null, needsApproval: false, memory: 4096, cores: 2, capNames: ["coding"] },
  "work-coding": { brain: "work", needsApproval: true, memory: 4096, cores: 2, capNames: ["coding"] },
  "pepper-coding": { brain: "pepper", needsApproval: true, memory: 4096, cores: 2, capNames: ["coding"] },
};

beforeEach(async () => {
  owner = await ownerToken();
  await send("PUT", `/api/boards/${BOARD}`, { name: "corkboard", root: "/home/matthew/corkboard" });
  expect((await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES })).status).toBe(200);
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
    expect((await send("POST", "/api/spawns", { template: "valheim", task: "x" })).body.error).toContain("there are coding, pepper-coding, work-coding");
    expect((await send("POST", "/api/spawns", { template: "coding", task: "x", environment: "cloud" })).status).toBe(400);
    expect((await send("POST", "/api/spawns", { template: "coding", task: "x", board: "nope" })).status).toBe(400);
    expect((await send("POST", "/api/spawns", { template: "coding", task: " " })).status).toBe(400);
  });

  it("lets a brain spawn its own templates and brainless ones, and holds those with credentials", async () => {
    await expect(spawn(env as any, USER, "pepper", { template: "work-coding", task: "x" })).rejects.toThrow("the work brain's");
    const free = await spawn(env as any, USER, "pepper", { template: "coding", task: "x" });
    expect(free.state).toBe("queued");
    const held = await spawn(env as any, USER, "pepper", { template: "pepper-coding", task: "read my mail" });
    expect(held).toMatchObject({ state: "pending-approval", brain: "pepper", by: "pepper" });
    expect((await card("fleet", held.card)).attention).toContain("approve: pepper wants to spawn pepper-coding");

    // Claiming waits for the approval, which clears the card's attention.
    expect((await send("POST", `/api/spawns/${held.id}/claim`, { environment: "local" })).status).toBe(409);
    const approved = await send("POST", `/api/spawns/${held.id}/approve`);
    expect(approved.body.state).toBe("queued");
    expect((await card("fleet", held.card)).attention).toBe(null);
    expect((await send("POST", `/api/spawns/${held.id}/approve`)).status).toBe(409);
  });
});

describe("fleetd's side", () => {
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
    slots: [{ name: "agent-0", spawn: "abc123def", template: "coding", memory: 4608 }, { name: "agent-1", spawn: null, template: null, memory: null }],
  };

  it("is kept as fleetd last said, through a look that doesn't say", async () => {
    expect((await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES, running: RUNNING })).status).toBe(200);
    expect((await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES })).status).toBe(200);
    const [local] = (await send("GET", "/api/fleet/environments")).body;
    expect(local.running).toEqual(RUNNING);
    expect((await tool(owner, "spawn_status")).environments[0].running).toEqual(RUNNING);
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
    expect(st.environments[0].templates.map((t: any) => t.name)).toEqual(["coding", "work-coding", "pepper-coding"]);
    expect(st.spawns[0].id).toBe(s.id);
    expect((await tool(owner, "spawn_status", { id: s.id })).card).toBe(s.card);
    expect((await tool(owner, "spawn_status", { id: "nope000" })).error).toContain("no spawn");
    expect((await tool(owner, "spawn_stop", { id: s.id })).state).toBe("stopped");

    const pepper = (await (await call(owner, "POST", "/api/tokens/pepper", {})).json<any>()).token as string;
    expect(await tools(pepper)).not.toContain("spawn_agent");
    expect(await tools(owner)).toEqual(expect.arrayContaining(["spawn_agent", "spawn_status", "spawn_stop"]));
  });
});
