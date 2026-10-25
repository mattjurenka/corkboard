import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerToken, worker } from "./login";

const BOARD = "home-matthew-agent-ide";

// Every test starts signed in, with one empty board, and ends with nothing.
let owner: string;
beforeEach(async () => {
  owner = await ownerToken();
  await send("PUT", `/api/boards/${BOARD}`, { name: "agent-ide", root: "/home/matthew/agent-ide" });
  await send("PUT", "/api/boards/other", {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function api(path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = owner, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (rest.body) headers.set("Content-Type", "application/json");
  return worker(path, { ...rest, headers });
}

const send = (method: string, path: string, body: unknown) => api(path, { method, body: JSON.stringify(body) });
const cards = (board = BOARD) => `/api/boards/${board}/cards`;

describe("auth", () => {
  it("refuses a missing or wrong token", async () => {
    expect((await api(cards(), { token: null })).status).toBe(401);
    expect((await api(cards(), { token: "nope" })).status).toBe(401);
    expect((await api(cards())).status).toBe(200);
  });
});

describe("boards", () => {
  it("lists the boards that were made", async () => {
    expect(await (await api("/api/boards")).json()).toEqual([
      { key: BOARD, name: "agent-ide", root: "/home/matthew/agent-ide" },
      { key: "other", name: "other", root: null },
    ]);
  });

  it("renames a board in place", async () => {
    await send("PUT", `/api/boards/${BOARD}`, { name: "corkboard", root: "/home/matthew/agent-ide" });
    const boards = await (await api("/api/boards")).json<{ name: string }[]>();
    expect(boards.map((b) => b.name)).toEqual(["corkboard", "other"]);
  });

  it("404s cards on a board nobody made", async () => {
    expect((await api(cards("typo"))).status).toBe(404);
    expect((await send("POST", cards("typo"), { title: "x" })).status).toBe(404);
  });

  it("refuses bad board fields and keys", async () => {
    expect((await send("PUT", "/api/boards/x", { name: "" })).status).toBe(400);
    expect((await send("PUT", "/api/boards/x", { colour: "red" })).status).toBe(400);
    expect((await send("PUT", "/api/boards/a%20b", {})).status).toBe(400);
  });

  it("keeps each user's boards to themselves", async () => {
    await send("POST", cards(), { title: "mine" });
    // Same board key, another account: a different board entirely. Only one
    // email is allowed in production; the test env lets a second sub in.
    const { google, login } = await import("./login");
    google("me@example.com", "another-sub");
    const { tokens } = await login();
    const theirs = await api(cards(), { token: tokens!.access_token });
    expect(theirs.status).toBe(404);
    expect(await (await api("/api/boards", { token: tokens!.access_token })).json()).toEqual([]);
  });
});

describe("cards", () => {
  it("creates numbered cards with defaults", async () => {
    const a = await (await send("POST", cards(), { title: "First" })).json<any>();
    const b = await (await send("POST", cards(), { title: "Second", status: "ready", labels: ["ui"] })).json<any>();
    expect(a).toMatchObject({ id: "TASK-1", title: "First", status: "backlog", version: 1, labels: [], agent: null });
    expect(b).toMatchObject({ id: "TASK-2", status: "ready", labels: ["ui"] });
    expect(a.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("keeps boards apart", async () => {
    await send("POST", cards(), { title: "Here" });
    expect(await (await api(cards("other"))).json()).toEqual([]);
    const there = await (await send("POST", cards("other"), { title: "There" })).json<any>();
    expect(there.id).toBe("TASK-1");
  });

  it("refuses bad fields instead of ignoring them", async () => {
    const bad = [{}, { title: " " }, { title: "x", status: "later" }, { title: "x", colour: "red" }, { title: "x", labels: "ui" }];
    for (const body of bad) expect((await send("POST", cards(), body)).status).toBe(400);
    expect((await api(cards(), { method: "POST", body: "not json" })).status).toBe(400);
  });

  it("lists in ordinal order, unordered last, then by number", async () => {
    await send("POST", cards(), { title: "a" });
    await send("POST", cards(), { title: "b", ordinal: 2 });
    await send("POST", cards(), { title: "c", ordinal: 1 });
    const list = await (await api(cards())).json<any[]>();
    expect(list.map((c: { title: string }) => c.title)).toEqual(["c", "b", "a"]);
  });

  it("reports what a card is waiting on", async () => {
    await send("POST", cards(), { title: "dep" });
    await send("POST", cards(), { title: "waits", dependencies: ["task-1", "TASK-9"] });
    let list = await (await api(cards())).json<any[]>();
    expect(list[1].waiting_on).toEqual(["TASK-1", "TASK-9 (no such card)"]);
    await send("PATCH", `${cards()}/TASK-1`, { version: 1, status: "done" });
    list = await (await api(cards())).json<any[]>();
    expect(list[1].waiting_on).toEqual(["TASK-9 (no such card)"]);
  });

  it("404s an unknown card and 400s a malformed id", async () => {
    expect((await api(`${cards()}/TASK-7`)).status).toBe(404);
    expect((await api(`${cards()}/seven`)).status).toBe(400);
  });
});

describe("versioned writes", () => {
  it("updates and bumps the version", async () => {
    await send("POST", cards(), { title: "Card" });
    const res = await send("PATCH", `${cards()}/task-1`, { version: 1, status: "doing", agent: "claude", attention: "look" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "doing", agent: "claude", attention: "look", version: 2 });
    const cleared = await send("PATCH", `${cards()}/TASK-1`, { version: 2, attention: null });
    expect(await cleared.json()).toMatchObject({ attention: null, version: 3 });
  });

  it("answers a stale version with 409 and the current card", async () => {
    await send("POST", cards(), { title: "Card" });
    await send("PATCH", `${cards()}/TASK-1`, { version: 1, title: "Renamed by the UI" });
    const res = await send("PATCH", `${cards()}/TASK-1`, { version: 1, status: "done" });
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.card).toMatchObject({ title: "Renamed by the UI", status: "backlog", version: 2 });
  });

  it("needs a version and something to change", async () => {
    await send("POST", cards(), { title: "Card" });
    expect((await send("PATCH", `${cards()}/TASK-1`, { status: "done" })).status).toBe(400);
    expect((await send("PATCH", `${cards()}/TASK-1`, { version: 1 })).status).toBe(400);
  });
});

describe("log", () => {
  it("appends without touching the version", async () => {
    await send("POST", cards(), { title: "Card" });
    expect((await send("POST", `${cards()}/TASK-1/log`, { who: "claude", note: "started" })).status).toBe(201);
    await send("POST", `${cards()}/TASK-1/log`, { who: "matthew", note: "looks good\nship it" });
    const c = await (await api(`${cards()}/TASK-1`)).json<any>();
    expect(c.version).toBe(1);
    expect(c.log.map((e: any) => [e.who, e.note])).toEqual([
      ["claude", "started"],
      ["matthew", "looks good\nship it"],
    ]);
    // An update after logging still applies: logs don't make versions stale.
    expect((await send("PATCH", `${cards()}/TASK-1`, { version: 1, status: "review" })).status).toBe(200);
  });

  it("needs who and a note, on a card that exists", async () => {
    await send("POST", cards(), { title: "Card" });
    expect((await send("POST", `${cards()}/TASK-1/log`, { who: "claude" })).status).toBe(400);
    expect((await send("POST", `${cards()}/TASK-2/log`, { who: "claude", note: "x" })).status).toBe(404);
  });
});

describe("live", () => {
  async function listen(board = BOARD) {
    const res = await api(`/api/boards/${board}/live`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const events: any[] = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
    // Resolves once n events have arrived.
    const next = async (n: number) => {
      for (let i = 0; i < 100 && events.length < n; i++) await new Promise((r) => setTimeout(r, 10));
      return events;
    };
    return { ws, events, next };
  }

  it("sends each write to every listener, after it's made", async () => {
    const a = await listen();
    const b = await listen();
    await send("POST", cards(), { title: "Card" });
    await send("PATCH", `${cards()}/TASK-1`, { version: 1, status: "doing" });
    await send("POST", `${cards()}/TASK-1/log`, { who: "claude", note: "started" });
    for (const l of [a, b]) {
      const events = await l.next(3);
      expect(events.map((e) => e.type)).toEqual(["card", "card", "log"]);
      expect(events[1].card).toMatchObject({ id: "TASK-1", status: "doing", version: 2 });
      expect(events[2]).toMatchObject({ id: "TASK-1", entry: { who: "claude", note: "started" } });
      expect(events[2].entry.seq).toBeTypeOf("number");
      l.ws.close();
    }
  });

  it("only hears its own board", async () => {
    const other = await listen("other");
    await send("POST", cards(), { title: "Here" });
    await send("POST", cards("other"), { title: "There" });
    const events = await other.next(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.map((e) => e.card.title)).toEqual(["There"]);
    other.ws.close();
  });

  it("needs a token and a board", async () => {
    expect((await api(`/api/boards/${BOARD}/live`, { token: null, headers: { Upgrade: "websocket" } })).status).toBe(401);
    expect((await api(`/api/boards/typo/live`, { headers: { Upgrade: "websocket" } })).status).toBe(404);
    expect((await api(`/api/boards/${BOARD}/live`)).status).toBe(426);
  });

  it("lists a whole board with logs, for a copy to start from", async () => {
    await send("POST", cards(), { title: "Card" });
    await send("POST", `${cards()}/TASK-1/log`, { who: "claude", note: "one" });
    await send("POST", `${cards()}/TASK-1/log`, { who: "claude", note: "two" });
    const [c] = await (await api(`${cards()}?log=1`)).json<any[]>();
    expect(c.log.map((e: any) => e.note)).toEqual(["one", "two"]);
    expect(c.log[1].seq).toBeGreaterThan(c.log[0].seq);
    const [plain] = await (await api(cards())).json<any[]>();
    expect(plain.log).toBeUndefined();
  });
});

describe("deleting a board", () => {
  it("removes its cards and its place in the list", async () => {
    await send("POST", cards(), { title: "Card" });
    expect((await api(`/api/boards/${BOARD}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(cards())).status).toBe(404);
    const boards = await (await api("/api/boards")).json<{ key: string }[]>();
    expect(boards.map((b) => b.key)).toEqual(["other"]);
    // Made again, it starts empty and numbers from 1.
    await send("PUT", `/api/boards/${BOARD}`, {});
    expect((await (await send("POST", cards(), { title: "Again" })).json<any>()).id).toBe("TASK-1");
  });
});

describe("import", () => {
  const card = (id: string, extra: object = {}) => ({
    id,
    title: `Card ${id}`,
    status: "review",
    agent: "claude",
    agent_state: "needs-review",
    labels: ["agents"],
    dependencies: [],
    description: "what it is",
    extra: { worktree: "/w" },
    created: "2026-10-23T06:51:00Z",
    updated: "2026-10-24T07:05:00Z",
    log: [
      { at: "2026-10-24T07:03:30Z", who: "claude", note: "claimed" },
      { at: "2026-10-24T07:05:14Z", who: "claude", note: "done\nverified" },
    ],
    ...extra,
  });

  it("keeps ids, times, logs and extra fields, and numbers on from the highest", async () => {
    const res = await send("POST", `/api/boards/${BOARD}/import`, { cards: [card("TASK-10"), card("TASK-3", { ordinal: 1 })] });
    expect(res.status).toBe(201);
    const c = await (await api(`${cards()}/TASK-10`)).json<any>();
    expect(c).toMatchObject({ id: "TASK-10", status: "review", agent: "claude", extra: { worktree: "/w" }, created: "2026-10-23T06:51:00Z", version: 1 });
    expect(c.log.map((e: any) => [e.at, e.note])).toEqual([
      ["2026-10-24T07:03:30Z", "claimed"],
      ["2026-10-24T07:05:14Z", "done\nverified"],
    ]);
    const list = await (await api(cards())).json<any[]>();
    expect(list.map((x) => x.id)).toEqual(["TASK-3", "TASK-10"]);
    expect((await (await send("POST", cards(), { title: "Next" })).json<any>()).id).toBe("TASK-11");
  });

  it("never overwrites: only into an empty board", async () => {
    await send("POST", cards(), { title: "Already here" });
    expect((await send("POST", `/api/boards/${BOARD}/import`, { cards: [card("TASK-5")] })).status).toBe(409);
  });

  it("checks every card before writing any", async () => {
    const bad = await send("POST", `/api/boards/${BOARD}/import`, { cards: [card("TASK-1"), card("TASK-2", { status: "later" })] });
    expect(bad.status).toBe(400);
    expect(await (await api(cards())).json()).toEqual([]);
    expect((await send("POST", `/api/boards/${BOARD}/import`, { cards: [card("TASK-1"), card("task-1")] })).status).toBe(400);
    expect((await send("POST", `/api/boards/${BOARD}/import`, { cards: [card("TASK-1", { created: "yesterday" })] })).status).toBe(400);
  });
});
