import { env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenKey } from "../src/api";
import { google, login, ownerToken, pepper, worker } from "./login";

let owner: string;
let assistant: string;

const call = (token: string, method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const send = async (method: string, path: string, body?: unknown) => {
  const res = await call(owner, method, path, body);
  return { status: res.status, body: res.status === 204 ? null : await res.json<any>() };
};
let rpcId = 0;
async function rpc(token: string, method: string, params: object = {}) {
  const res = await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method, params });
  return res.status === 200 ? (await res.json<any>()).result : { status: res.status };
}
async function tool(token: string, name: string, args: object = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
}
const names = async (token: string) => ((await rpc(token, "tools/list")).tools ?? []).map((t: any) => t.name) as string[];
const tokenFor = async (brain: string) => (await send("POST", `/api/brains/${brain}/tokens`)).body.token as string;

beforeEach(async () => {
  owner = await ownerToken();
  google("me@example.com");
  const { tokens } = await login({ scope: "assistant" });
  vi.restoreAllMocks();
  assistant = tokens!.access_token;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("brains", () => {
  it("start as a plain assistant, the default, with the chat and nothing held", async () => {
    const { body } = await send("GET", "/api/brains");
    expect(body.map((b: any) => b.name)).toEqual(["assistant"]);
    expect(body[0]).toMatchObject({ title: "Assistant", account: null, credentials: [], persona: null, default: true, abilities: ["chat"], memory: { notes: 0, entries: 0, episodes: 0 } });
  });

  it("are made, read, changed against their version, and named for good", async () => {
    const made = await send("POST", "/api/brains", { name: "work", title: "Stable", account: "work", credentials: ["github"] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: "work", default: false, abilities: [] });
    expect((await send("POST", "/api/brains", { name: "work", title: "Again" })).status).toBe(409);
    expect((await send("POST", "/api/brains", { name: "Work!", title: "x" })).status).toBe(400);
    expect((await send("POST", "/api/brains", { name: "x", title: "x", abilities: ["fly"] })).status).toBe(400);

    const changed = await send("PATCH", "/api/brains/work", { updated: made.body.updated, title: "Stable work" });
    expect(changed.body.title).toBe("Stable work");
    const stale = await send("PATCH", "/api/brains/work", { updated: made.body.updated, title: "Lost" });
    expect(stale.status).toBe(409);
    expect(stale.body.brain.title).toBe("Stable work");
    expect((await send("PATCH", "/api/brains/work", { updated: changed.body.updated, name: "job" })).status).toBe(400);
    expect((await send("GET", "/api/brains/work")).body.title).toBe("Stable work");
  });

  it("have a persona, one of the avatar's, or none", async () => {
    const made = await send("POST", "/api/brains", { name: "work", title: "Stable", persona: "businesswoman" });
    expect(made.body.persona).toBe("businesswoman");
    expect((await send("GET", "/api/brains/assistant")).body.persona).toBeNull();
    expect((await send("POST", "/api/brains", { name: "x", title: "x", persona: "pirate" })).status).toBe(400);
    const cleared = await send("PATCH", "/api/brains/work", { updated: made.body.updated, persona: null });
    expect(cleared.body.persona).toBeNull();
  });

  it("have a skin colour, or the model's own", async () => {
    const made = await send("POST", "/api/brains", { name: "tan", title: "Tan", skin: "#c68a5e" });
    expect(made.body.skin).toBe("#c68a5e");
    expect((await send("GET", "/api/brains/assistant")).body.skin).toBeNull();
    expect((await send("POST", "/api/brains", { name: "y", title: "y", skin: "brown" })).status).toBe(400);
    const cleared = await send("PATCH", "/api/brains/tan", { updated: made.body.updated, skin: null });
    expect(cleared.body.skin).toBeNull();
  });

  it("have one default, which your own sessions remember in", async () => {
    const made = (await send("POST", "/api/brains", { name: "work", title: "Stable", default: true })).body;
    expect((await send("GET", "/api/brains/assistant")).body.default).toBe(false);
    await tool(assistant, "memory_remember", { text: "Standup is at ten." });
    expect((await (await tokenFor("work")) && (await tool(await tokenFor("work"), "memory_recall", { query: "standup" })))[0].snippet).toContain("Standup");
    await send("PATCH", "/api/brains/work", { updated: made.updated, default: false });
    expect((await tool(assistant, "memory_remember", { text: "x" })).error).toMatch(/no default brain/);
  });

  it("give their abilities' tools only to their own agents", async () => {
    await send("POST", "/api/brains", { name: "work", title: "Stable" });
    expect(await names(await tokenFor("assistant"))).toContain("chat_send");
    expect(await names(await tokenFor("work"))).not.toContain("chat_send");
    expect(await names(assistant)).not.toContain("chat_send");
    // A token from before brains were data is still Pepper's, in an account that has it.
    await pepper(owner);
    await (env as any).OAUTH_KV.put(await tokenKey("cbc_old"), JSON.stringify({ userId: "sub-me@example.com", email: "me@example.com", grant: { kind: "pepper", agent: "pepper" } }));
    expect(await names("cbc_old")).toContain("chat_send");
  });

  it("archived, are out of lists and their tokens stop; restored, both come back", async () => {
    await send("POST", "/api/brains", { name: "work", title: "Stable" });
    const t = await tokenFor("work");
    await tool(t, "memory_remember", { text: "Kept through an archive." });
    expect((await send("DELETE", "/api/brains/work")).body.archived).toBeTruthy();
    expect((await send("GET", "/api/brains")).body.map((b: any) => b.name)).toEqual(["assistant"]);
    expect((await send("GET", "/api/brains?archived=1")).body.map((b: any) => b.name)).toEqual(["assistant", "work"]);
    expect(await rpc(t, "tools/list")).toMatchObject({ status: 403 });
    expect((await send("POST", "/api/brains/work/tokens")).status).toBe(404);
    expect((await send("POST", "/api/brains", { name: "work", title: "New" })).status).toBe(409);
    await send("POST", "/api/brains/work/restore");
    expect((await tool(t, "memory_recall", { query: "archive" }))[0].snippet).toContain("Kept");
  });

  it("purged, lose their memory and free the name, and old tokens don't reach the new one", async () => {
    await send("POST", "/api/brains", { name: "work", title: "Stable" });
    const t = await tokenFor("work");
    await tool(t, "memory_remember", { text: "Gone after the purge." });
    expect((await send("DELETE", "/api/brains/work?purge=work")).status).toBe(409);
    await send("DELETE", "/api/brains/work");
    expect((await send("DELETE", "/api/brains/work?purge=wrong")).status).toBe(400);
    expect((await send("DELETE", "/api/brains/work?purge=work")).status).toBe(204);
    expect((await send("POST", "/api/brains", { name: "work", title: "Fresh" })).status).toBe(201);
    expect((await send("GET", "/api/brains/work")).body.memory.entries).toBe(0);
    expect(await rpc(t, "tools/list")).toMatchObject({ status: 403 });
  });

  it("go with the account's export", async () => {
    await send("POST", "/api/brains", { name: "work", title: "Stable" });
    const exported = (await send("GET", "/api/export")).body;
    expect(Object.keys(exported.memory).sort()).toEqual(["assistant", "work"]);
    expect(exported.user.brains.length).toBe(2);
  });
});

describe("brain tools", () => {
  it("list, make and change brains for your own clients only", async () => {
    expect((await tool(assistant, "brain_list")).map((b: any) => b.name)).toEqual(["assistant"]);
    const made = await tool(assistant, "brain_create", { name: "garden", title: "Garden" });
    expect(made.name).toBe("garden");
    expect((await tool(assistant, "brain_update", { name: "garden", updated: made.updated, title: "The garden" })).title).toBe("The garden");
    expect((await tool(assistant, "brain_update", { name: "garden", updated: made.updated, title: "x" })).error).toMatch(/changed since/);
    expect(await tool(assistant, "brain_read", { name: "garden" })).toMatchObject({ title: "The garden", memory: { notes: 0, entries: 0, episodes: 0, lastEpisode: null } });
    expect((await tool(assistant, "brain_read", { name: "nobody" })).error).toMatch(/no brain nobody/);
    expect(await names(await tokenFor("assistant"))).not.toContain("brain_create");
    expect(await names(await tokenFor("assistant"))).not.toContain("brain_read");
  });
});
