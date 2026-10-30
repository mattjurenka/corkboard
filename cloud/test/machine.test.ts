import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerToken, worker } from "./login";

// A machine token (/api/tokens/machine): the droplet's, which may use the API
// but not reach the laptop's sessions or fleet through it.

const BOARD = "home-matthew-corkboard";
const TEMPLATES = { coding: { brain: null, needsApproval: false, memory: 4096, cores: 2, capNames: ["coding"] } };

let owner: string;
let machine: string;

const call = (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  owner = await ownerToken();
  await call(owner, "PUT", `/api/boards/${BOARD}`, { name: "corkboard" });
  for (const name of ["laptop", "cloud"]) expect((await call(owner, "PUT", `/api/fleet/environments/${name}`, { templates: TEMPLATES })).status).toBe(200);
  const res = await call(owner, "POST", "/api/tokens/machine", { environment: "cloud" });
  expect(res.status).toBe(201);
  const minted = await res.json<{ token: string; expires_at: string | null }>();
  expect(minted.expires_at).toBeNull();
  machine = minted.token;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function bridge(token: string, query: string, environment: string, headers: Record<string, string> = {}) {
  const res = await call(token, "GET", `/api/live${query}`, undefined, { Upgrade: "websocket", ...headers });
  if (res.status !== 101) return { status: res.status };
  const ws = res.webSocket!;
  ws.accept();
  ws.addEventListener("message", (e) => {
    const q = JSON.parse(e.data as string);
    if (q.type === "say") ws.send(JSON.stringify({ type: "answer", ask: q.ask, ok: true }));
  });
  ws.send(JSON.stringify({ type: "sessions", environment, sessions: [{ key: "1-1", project: "p", name: "n", state: "idle" }] }));
  for (let i = 0; i < 100; i++) {
    const listed = await (await call(owner, "GET", "/api/sessions")).json<{ id: string }[]>();
    if (listed.some((b) => query.includes(b.id))) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { status: 101, ws };
}

describe("a machine token", () => {
  it("uses boards like the owner", async () => {
    expect((await call(machine, "GET", "/api/boards")).status).toBe(200);
    const made = await call(machine, "POST", `/api/boards/${BOARD}/cards`, { title: "from the droplet" });
    expect(made.status).toBe(201);
    const { id } = await made.json<{ id: string }>();
    expect((await call(machine, "POST", "/api/tokens", { board: BOARD, card: id, agent: "claude" })).status).toBe(201);
  });

  it("can't export, import, mint tickets or machine tokens, or use MCP", async () => {
    expect((await call(machine, "GET", "/api/export")).status).toBe(403);
    expect((await call(machine, "POST", "/api/import", {})).status).toBe(403);
    expect((await call(machine, "POST", "/api/tokens/machine", { environment: "laptop" })).status).toBe(403);
    expect((await call(machine, "POST", "/api/workspace/tickets", { bridge: "x", board: BOARD })).status).toBe(403);
    expect((await call(machine, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    expect((await call(machine, "GET", "/memory/context")).status).toBe(403);
  });

  it("types into its own environment's sessions, never another's", async () => {
    const laptop = await bridge(owner, "?bridge=laptop-7777&machine=laptop", "laptop");
    // It says it's the laptop; it's put in its own environment anyway.
    const droplet = await bridge(machine, "?bridge=droplet-7790&machine=droplet", "laptop");
    const listed = await (await call(owner, "GET", "/api/sessions")).json<{ id: string; environment: string }[]>();
    expect(listed.find((b) => b.id === "droplet-7790")?.environment).toBe("cloud");

    const say = (token: string, id: string) => call(token, "POST", `/api/sessions/${id}/1-1/say`, { text: "yes" });
    expect((await say(machine, "droplet-7790")).status).toBe(200);
    expect((await say(machine, "laptop-7777")).status).toBe(403);
    expect((await call(machine, "GET", "/api/sessions/laptop-7777/1-1")).status).toBe(403);
    expect((await call(machine, "GET", "/api/sessions/laptop-7777/1-1/attach", undefined, { Upgrade: "websocket" })).status).toBe(403);
    expect((await say(owner, "laptop-7777")).status).toBe(200);
    expect((await say(owner, "droplet-7790")).status).toBe(200);

    // Nor can it take over the laptop's bridge by its id.
    expect((await bridge(machine, "?bridge=laptop-7777&machine=x", "cloud")).status).toBe(403);
    laptop.ws!.close();
    droplet.ws!.close();
  });

  it("can't name another environment in the Worker's own header", async () => {
    const b = await bridge(machine, "?bridge=desk-1&machine=desk", "laptop", { "Corkboard-Machine": "laptop" });
    const listed = await (await call(owner, "GET", "/api/sessions")).json<{ id: string; environment: string }[]>();
    expect(listed.find((x) => x.id === "desk-1")?.environment).toBe("cloud");
    b.ws!.close();
  });

  it("runs only its own environment's fleet, and approves nothing", async () => {
    expect((await call(machine, "PUT", "/api/fleet/environments/cloud", { templates: TEMPLATES })).status).toBe(200);
    expect((await call(machine, "PUT", "/api/fleet/environments/laptop", { templates: TEMPLATES })).status).toBe(403);
    expect((await call(machine, "DELETE", "/api/fleet/environments/laptop")).status).toBe(403);

    expect((await call(machine, "POST", "/api/spawns", { template: "coding", task: "x", environment: "laptop" })).status).toBe(403);
    const own = await (await call(machine, "POST", "/api/spawns", { template: "coding", task: "x" })).json<{ id: string; environment: string }>();
    expect(own.environment).toBe("cloud");

    const theirs = await (await call(owner, "POST", "/api/spawns", { template: "coding", task: "x", environment: "laptop" })).json<{ id: string }>();
    expect((await call(machine, "POST", `/api/spawns/${theirs.id}/claim`, { environment: "laptop" })).status).toBe(403);
    expect((await call(machine, "POST", `/api/spawns/${theirs.id}/stop`, {})).status).toBe(403);
    expect((await call(machine, "POST", `/api/spawns/${theirs.id}/report`, { state: "running" })).status).toBe(403);
    expect((await call(machine, "POST", `/api/spawns/${own.id}/approve`, {})).status).toBe(403);
    expect((await call(machine, "POST", `/api/spawns/${own.id}/claim`, { environment: "cloud" })).status).toBe(200);
  });

  it("is revoked by the owner, not by another machine", async () => {
    const other = (await (await call(owner, "POST", "/api/tokens/machine", { environment: "box" })).json<{ token: string }>()).token;
    expect((await call(other, "POST", "/api/tokens/revoke", { token: machine })).status).toBe(403);
    expect((await call(owner, "POST", "/api/tokens/revoke", { token: machine })).status).toBe(204);
    expect((await call(machine, "GET", "/api/boards")).status).toBe(401);
  });
});
