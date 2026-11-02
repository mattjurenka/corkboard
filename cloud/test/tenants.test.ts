import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invitedToken, ownerToken, worker } from "./login";

// Two users of one Worker: A, the admin, and B, invited. Everything is keyed
// by the user's sub, so nothing of A's is B's to read, change or revoke.

let a: string;
let b: string;
beforeEach(async () => {
  a = await ownerToken();
  b = await invitedToken(a);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const call = (token: string, method: string, path: string, body?: unknown, init: RequestInit = {}) =>
  worker(path, {
    ...init,
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function tool(token: string, name: string, args: object = {}) {
  const res = await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const r = (await res.json<any>()).result;
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
}

const BOARD = "home-a-project";

async function aBoard() {
  expect((await call(a, "PUT", `/api/boards/${BOARD}`, { name: "A's project" })).status).toBe(200);
  const card = await (await call(a, "POST", `/api/boards/${BOARD}/cards`, { title: "A's card" })).json<{ id: string; version: number }>();
  return card;
}

async function bridge(token: string, id: string) {
  const res = await call(token, "GET", `/api/live?bridge=${id}&machine=desk&url=${encodeURIComponent("https://a.test:8443")}`, undefined, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  ws.send(JSON.stringify({ type: "sessions", environment: "local", sessions: [{ key: "1-1", project: "p", name: "n", state: "idle" }] }));
  for (let i = 0; i < 100 && !(await (await call(token, "GET", "/api/sessions")).json<any[]>()).length; i++) await new Promise((r) => setTimeout(r, 10));
  return ws;
}

describe("another user", () => {
  it("can't see or change A's boards and cards, over the API or MCP", async () => {
    const card = await aBoard();
    expect(await (await call(b, "GET", "/api/boards")).json()).toEqual([]);
    expect((await call(b, "GET", `/api/boards/${BOARD}/cards`)).status).toBe(404);
    expect((await call(b, "GET", `/api/boards/${BOARD}/cards/${card.id}`)).status).toBe(404);
    expect((await call(b, "PATCH", `/api/boards/${BOARD}/cards/${card.id}`, { version: card.version, title: "B was here" })).status).toBe(404);
    expect((await call(b, "POST", `/api/boards/${BOARD}/cards/${card.id}/log`, { who: "b", note: "x" })).status).toBe(404);
    expect(await tool(b, "list_boards")).toEqual([]);
    expect((await tool(b, "read_card", { board: BOARD, id: card.id })).error).toBeTruthy();
    expect((await call(b, "POST", "/api/tokens", { board: BOARD, card: card.id, agent: "b" })).status).toBe(404);
    // B's board of the same key is B's own.
    expect((await call(b, "PUT", `/api/boards/${BOARD}`, { name: "B's" })).status).toBe(200);
    expect((await (await call(b, "GET", `/api/boards/${BOARD}/cards`)).json<any[]>()).length).toBe(0);
    expect((await (await call(a, "GET", `/api/boards/${BOARD}/cards/${card.id}`)).json<any>()).title).toBe("A's card");
  });

  it("can't see A's files on cards", async () => {
    const card = await aBoard();
    const m = await tool(a, "attach_file", { board: BOARD, id: card.id, name: "a.png", data: btoa("\x89PNG....") });
    expect((await call(a, "GET", `/api/boards/${BOARD}/cards/${card.id}/media/${m.id}`)).status).toBe(200);
    expect((await call(b, "PUT", `/api/boards/${BOARD}`, { name: "B's" })).status).toBe(200);
    expect((await call(b, "GET", `/api/boards/${BOARD}/cards/${card.id}/media/${m.id}`)).status).toBe(404);
  });

  it("can't see, ask or disconnect A's bridges, or redeem A's tickets", async () => {
    await aBoard();
    const ws = await bridge(a, "desk-1");
    expect(await (await call(b, "GET", "/api/sessions")).json()).toEqual([]);
    expect((await call(b, "GET", "/api/sessions/desk-1/1-1")).status).toBe(404);
    expect((await call(b, "POST", "/api/sessions/desk-1/1-1/say", { text: "rm -rf" })).status).toBe(404);
    expect((await call(b, "GET", "/api/sessions/desk-1/1-1/attach", undefined, { headers: { Upgrade: "websocket" } })).status).toBe(404);
    expect((await call(b, "DELETE", "/api/bridges/desk-1")).status).toBe(404);
    const made = await (await call(a, "POST", "/api/workspace/tickets", { bridge: "desk-1", board: BOARD })).json<any>();
    const ticket = new URL(made.url).searchParams.get("ticket")!;
    expect((await call(b, "POST", "/api/workspace/redeem", { bridge: "desk-1", ticket })).status).toBe(403);
    expect((await call(b, "POST", "/api/workspace/tickets", { bridge: "desk-1", board: BOARD })).status).toBe(404);
    // A's ticket still works for A.
    expect((await call(a, "POST", "/api/workspace/redeem", { bridge: "desk-1", ticket })).status).toBe(200);
    // And A can disconnect it.
    expect((await call(a, "DELETE", "/api/bridges/desk-1")).status).toBe(204);
    ws.close();
  });

  it("can't see A's holds or their secrets, plans, chat or memory", async () => {
    await call(a, "POST", "/api/holds", { name: "github", about: "A's", secret: "ghp_a" });
    await call(a, "PUT", "/api/notes/who", { kind: "reference", title: "Who", body: "A's note" });
    await call(a, "POST", "/api/chat", { text: "A's message" });
    expect(await (await call(b, "GET", "/api/holds")).json()).toEqual([]);
    expect((await call(b, "GET", "/api/holds/github")).status).toBe(404);
    expect((await call(b, "GET", "/api/notes/who")).status).toBe(404);
    expect(await (await call(b, "GET", "/api/chat")).json()).toEqual([]);
    expect((await (await call(b, "GET", "/api/export")).json<any>()).holds.secrets).toEqual({});
  });

  it("can't read A's git: Forgejo is the admins'", async () => {
    expect((await call(b, "GET", "/api/git")).status).toBe(403);
    expect((await call(b, "GET", "/api/git/repos")).status).toBe(403);
    expect((await call(b, "GET", "/api/git/repos/m/corkboard/info/refs?service=git-upload-pack")).status).toBe(403);
    expect((await call(a, "GET", "/api/git")).status).toBe(200);
  });

  it("can't list or revoke A's tokens or sign-ins", async () => {
    const machine = await (await call(a, "POST", "/api/tokens/machine", { environment: "droplet", label: "the droplet" })).json<any>();
    expect(await (await call(b, "GET", "/api/tokens/machine")).json()).toEqual([]);
    expect((await call(b, "DELETE", `/api/tokens/machine/${machine.id}`)).status).toBe(404);
    expect((await call(b, "POST", "/api/tokens/revoke", { token: machine.token })).status).toBe(204);
    expect((await call(machine.token, "GET", "/api/boards")).status).toBe(200);

    const theirs = await (await call(a, "GET", "/api/grants")).json<any[]>();
    expect(theirs.length).toBeGreaterThan(0);
    const mine = await (await call(b, "GET", "/api/grants")).json<any[]>();
    expect(mine.map((g) => g.id)).not.toContain(theirs[0].id);
    await call(b, "DELETE", `/api/grants/${encodeURIComponent(theirs[0].id)}`).catch(() => null);
    expect((await call(a, "GET", "/api/boards")).status).toBe(200);
  });
});

describe("your tokens and sign-ins", () => {
  it("list machine tokens with when each was used, and revoke them", async () => {
    const t = await (await call(a, "POST", "/api/tokens/machine", { environment: "droplet", label: "the droplet", expires_in: 3600 })).json<any>();
    expect(t.expires_at).toBeTruthy();
    expect((await call(t.token, "GET", "/api/boards")).status).toBe(200);
    const list = await (await call(a, "GET", "/api/tokens/machine")).json<any[]>();
    expect(list).toEqual([expect.objectContaining({ id: t.id, environment: "droplet", label: "the droplet", used: expect.any(String) })]);
    expect(JSON.stringify(list)).not.toContain(t.token);
    expect((await call(t.token, "GET", "/api/tokens/machine")).status).toBe(403);
    expect((await call(a, "DELETE", `/api/tokens/machine/${t.id}`)).status).toBe(204);
    expect((await call(t.token, "GET", "/api/boards")).status).toBe(401);
    expect(await (await call(a, "GET", "/api/tokens/machine")).json()).toEqual([]);
    expect((await call(a, "POST", "/api/tokens/machine", { environment: "droplet", expires_in: 5 })).status).toBe(400);
  });

  it("list OAuth sign-ins, and sign one out", async () => {
    const other = await ownerToken();
    const grants = await (await call(a, "GET", "/api/grants")).json<any[]>();
    expect(grants.length).toBe(2);
    expect(grants[0]).toMatchObject({ client: "corkboard bridge", scope: ["owner"] });
    const theOther = grants.find((g) => !g.current) ?? grants[0];
    expect((await call(a, "DELETE", `/api/grants/${encodeURIComponent(theOther.id)}`)).status).toBe(204);
    const left = [a, other].filter(Boolean);
    const working = await Promise.all(left.map(async (t) => (await call(t, "GET", "/api/boards")).status));
    expect(working.sort()).toEqual([200, 401]);
  });
});
