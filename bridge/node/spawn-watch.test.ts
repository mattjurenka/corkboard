import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Seen, SpawnWatch } from "./spawn-watch";
import { rpc, setup, toolText } from "./testing";
import type { Fleet } from "./mcp";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("SpawnWatch", () => {
  let spawns: Seen[];
  let looks = 0;
  const told: string[] = [];
  const make = () => {
    spawns = [{ id: "a", state: "running", board: "proj", card: "TASK-1" }, { id: "b", state: "running" }];
    looks = 0;
    told.length = 0;
    return new SpawnWatch(
      async () => (looks++, spawns.map((s) => ({ ...s }))),
      async (id) => spawns.find((s) => s.id === id),
      (c) => void told.push(`${c.id}:${c.summary}`),
      10,
    );
  };
  const set = (id: string, state: string, more: Partial<Seen> = {}) => void Object.assign(spawns.find((s) => s.id === id)!, { state }, more);

  it("answers the waiters of a spawn that changes, and only those", async () => {
    const w = make();
    const a = w.wait(["a"], 2000);
    const all = w.wait([], 2000);
    await tick();
    set("b", "failed", { error: "no HEAD\nmore" });
    expect((await all).changes).toMatchObject([{ id: "b", from: "running", state: "failed", summary: "failed: no HEAD" }]);
    set("a", "done", { result: "Fixed it.\nDetails." });
    const got = await a;
    expect(got.changes).toMatchObject([{ id: "a", card: "TASK-1", board: "proj", summary: "done: Fixed it." }]);
    expect(told).toEqual(["b:failed: no HEAD", "a:done: Fixed it."]);
  });

  it("times out with nothing, and polls no more once no one waits", async () => {
    const w = make();
    expect((await w.wait(["a"], 50)).changes).toEqual([]);
    await tick(40);
    const n = looks;
    await tick(60);
    expect(looks).toBe(n);
  });

  it("shares one loop between many waiters", async () => {
    const w = make();
    const waits = Array.from({ length: 40 }, () => w.wait([], 150));
    await tick(100);
    expect(looks).toBeLessThan(15);
    await Promise.all(waits);
  });

  it("tells a spawn that already ended, unless a cursor says what's been seen", async () => {
    const w = make();
    set("a", "done", { result: "ok" });
    const first = await w.wait(["a"], 1000);
    expect(first.changes).toMatchObject([{ id: "a", state: "done" }]);
    expect((await w.wait(["a"], 30, first.cursor)).changes).toEqual([]);
  });

  it("gives what changed between two waits by the cursor", async () => {
    const w = make();
    const first = await w.wait(["b"], 20);
    expect(first.changes).toEqual([]);
    const pending = w.wait(["a"], 1000);
    await tick();
    set("b", "done");
    await tick(40);
    set("a", "stopped");
    await pending;
    expect((await w.wait([], 20, first.cursor)).changes.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("keeps looking for a notify spawn nobody waits on, until it ends", async () => {
    const w = make();
    w.tell("a");
    await tick(40);
    set("a", "failed", { error: "boom" });
    await tick(40);
    expect(told).toEqual(["a:failed: boom"]);
    const n = looks;
    await tick(50);
    expect(looks).toBe(n);
  });
});

describe("wait_for over the node's MCP", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  let state = "queued";
  let result: string | undefined;
  const fleet: Fleet = async (method, path, body?: any) => {
    if (path === "/spawns") return { id: "sp1", template: "coding", environment: "droplet", agent: "fleet-sp1", state: "queued" };
    if (path === "/fleet/status") return { spawns: [{ id: "sp1", state, board: "proj", card: cardId, ...(result && { result }) }] };
    return {};
  };
  let cardId = "";
  const tool = async (name: string, args: Record<string, unknown> = {}) => toolText(await n.call("/mcp", rpc("tools/call", { name, arguments: args }, n.oauth.mint("phone", 1))));
  beforeAll(async () => void (n = await setup({ fleet })));
  afterAll(() => n.stop());

  it("lists wait_for and spawn_agent's notify", async () => {
    const list = (await (await n.call("/mcp", rpc("tools/list", {}, n.oauth.mint("phone", 1)))).json()) as any;
    const tools = list.result.tools as { name: string; inputSchema: { properties: object } }[];
    expect(tools.map((t) => t.name)).toContain("wait_for");
    expect(Object.keys(tools.find((t) => t.name === "spawn_agent")!.inputSchema.properties)).toContain("notify");
  });

  it("answers when the spawn ends, and puts it in its card's attention", async () => {
    cardId = (await n.data.createCard("proj", { title: "Fix it", status: "ready" })).id;
    const s = JSON.parse((await tool("spawn_agent", { task: "x", board: "proj", card: cardId, notify: true })).text);
    expect(s.id).toBe("sp1");
    const waiting = tool("wait_for", { ids: ["sp1"], timeout: 5 });
    await tick(100);
    state = "done";
    result = "All fixed.\nSee the branch.";
    const out = JSON.parse((await waiting).text);
    expect(out.changes).toMatchObject([{ id: "sp1", from: "queued", state: "done", card: cardId, summary: "done: All fixed." }]);
    await tick(50);
    expect(n.data.card("proj", cardId).attention).toBe("spawn sp1: done: All fixed.");
  });

  it("answers with a note when nothing changes", async () => {
    const out = JSON.parse((await tool("wait_for", { ids: ["nobody"], timeout: 1 })).text);
    expect(out.changes).toEqual([]);
    expect(out.note).toContain("nothing changed");
  });
});
