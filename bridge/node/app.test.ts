import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardEvent } from "../../lib/model/cards";
import { type AppNode, boardEvents, boards, brains, dayEvents, notes, plans, runningNode } from "./app";
import type { StartedNode } from "./serve";
import { node } from "./server";
import { ORIGIN, setup } from "./testing";

// A node served on loopback as another bridge's would be, its /app answered
// as startAppNode answers it, and the files that say where it is.
async function running() {
  const n = await setup();
  const s = n as unknown as StartedNode;
  const call = (op: string, args: any[]) =>
    op.startsWith("board_") ? boards(s, op.slice("board_".length), args) : (op.startsWith("brains_") ? brains : op.startsWith("plan_") ? plans : notes)(s, op, args);
  const events = (fn: (key: string | null, event: unknown) => void) => {
    const b = boardEvents(n)(fn);
    const d = dayEvents(n)((event) => fn(null, event));
    return () => (b(), d());
  };
  const app = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN, app: () => call, appEvents: () => events });
  let server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app });
  const port = server.port!;
  const files = { mcp: join(n.dir, "session-mcp.json"), owner: join(n.dir, "owner-token") };
  const write = (token = n.oauth.mint("corkboard on this machine", 1, "owner")) => {
    writeFileSync(files.mcp, JSON.stringify({ mcpServers: { "corkboard-memory": { url: `http://127.0.0.1:${port}/mcp?tools=memory` } } }));
    writeFileSync(files.owner, token + "\n");
  };
  return {
    n,
    files,
    write,
    stop: () => server.stop(true),
    // The same node, back on its port.
    restart: () => void (server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app })),
    close: async () => (server.stop(true), await n.stop()),
  };
}

const until = async (ok: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};
const closing: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of closing) await c();
});

describe("a bridge using the node another bridge runs", () => {
  it("asks it on /app with the owner's token, and hears its boards' and days' events", async () => {
    const r = await running();
    closing.push(r.close);
    r.write();
    const app = (await runningNode(1234, r.files, { tries: 0 })) as AppNode;
    expect(app).toBeDefined();
    // Sessions started here use it too.
    expect(app.env.CORKBOARD_MEMORY_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(((await app.boards("boards", [])) as { key: string }[]).map((b) => b.key)).toEqual(["proj"]);
    const made = (await app.boards("create", ["proj", { title: "Over /app" }])) as { id: string };
    expect(r.n.data.card("proj", made.id).title).toBe("Over /app");
    expect(((await app.brains("brains_get", [])) as { name: string }[]).map((b) => b.name)).toContain("assistant");
    // A refusal comes back as one.
    await expect(app.boards("update", ["proj", "TASK-NONE", 1, {}])).rejects.toThrow();

    const heard: [string, BoardEvent][] = [];
    const days: unknown[] = [];
    const off = app.onBoard((key, event) => void heard.push([key, event]));
    const offDay = app.onDay((event) => void days.push(event));
    await Bun.sleep(100);
    const c = await r.n.data.createCard("proj", { title: "Heard" });
    await until(() => heard.some(([, e]) => e.type === "card" && (e as { card: { id: string } }).card.id === c.id));
    expect(heard.at(-1)![0]).toBe("proj");
    await r.n.data.say(r.n.data.today(), "user", "Move lunch.");
    await until(() => days.length > 0);
    off();
    offDay();
  });

  it("is told each board whole again after the node comes back", async () => {
    const r = await running();
    closing.push(r.close);
    r.write();
    const app = (await runningNode(1234, r.files, { tries: 0 }))!;
    const heard: [string, BoardEvent][] = [];
    const off = app.onBoard((key, event) => void heard.push([key, event]));
    await Bun.sleep(100);
    r.stop();
    // Missed while it was gone.
    const missed = await r.n.data.createCard("proj", { title: "Missed" });
    await Bun.sleep(300);
    r.restart();
    await until(() => heard.some(([, e]) => e.type === "snapshot"), 10_000);
    const [key, snap] = heard.find(([, e]) => e.type === "snapshot")!;
    expect(key).toBe("proj");
    expect((snap as { cards: { id: string }[] }).cards.map((x) => x.id)).toContain(missed.id);
    off();
  }, 20_000);

  it("waits for one still starting, and isn't used when it answers with a refusal", async () => {
    const r = await running();
    closing.push(r.close);
    // Not there yet: its files come a moment later.
    setTimeout(() => r.write(), 1200);
    const app = await runningNode(1234, r.files, { tries: 5 });
    expect(app).toBeDefined();
    // A token it doesn't take: an answer, so not tried again.
    r.write("not-a-token");
    const started = Date.now();
    expect(await runningNode(1234, r.files, { tries: 5 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  }, 15_000);
});
