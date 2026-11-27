import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Cloud, type Link, Session, USER } from "./cloud-session";
import type { Peers } from "./peers";

// The Worker's API as cloud-session.ts calls it, served here on a port of
// its own: each request, and each socket by its path. answer, when set,
// answers a request before the routes do.
type Sock = ServerWebSocket<{ path: string; auth: string | null }>;
const asked: { method: string; path: string; body: any; auth: string | null }[] = [];
const sockets: Sock[] = [];
const said: [string, string][] = [];
let answer: ((method: string, path: string, body: any) => Response | undefined) | undefined;
const boards = new Map<string, { name?: string; root?: string | null; commit?: string; cards: { id: string; title: string; version: number }[] }>();

const worker = Bun.serve<{ path: string; auth: string | null }>({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req, s) {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const auth = req.headers.get("authorization");
    if (req.headers.get("upgrade") === "websocket") return s.upgrade(req, { data: { path, auth } }) ? undefined : new Response("no", { status: 400 });
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => undefined);
    asked.push({ method: req.method, path, body, auth });
    const a = answer?.(req.method, path, body);
    if (a) return a;
    let m: RegExpMatchArray | null;
    if (url.pathname === "/api/boards" && req.method === "GET") return Response.json([...boards].map(([key, b]) => ({ key, commit: b.commit })));
    if ((m = url.pathname.match(/^\/api\/boards\/([^/]+)$/)) && req.method === "PUT") {
      const b = boards.get(m[1]) ?? { cards: [] };
      boards.set(m[1], { ...b, ...body });
      return Response.json({ key: m[1] });
    }
    if ((m = url.pathname.match(/^\/api\/boards\/([^/]+)\/cards$/))) {
      const b = boards.get(m[1]);
      if (!b) return Response.json({ error: "no such board" }, { status: 404 });
      if (req.method === "GET") return Response.json(b.cards);
      const card = { id: `TASK-${b.cards.length + 1}`, title: body.title, version: 1 };
      b.cards.push(card);
      return Response.json(card, { status: 201 });
    }
    if ((m = url.pathname.match(/^\/api\/boards\/([^/]+)\/cards\/([^/]+)$/)) && req.method === "PATCH") {
      const card = boards.get(m[1])?.cards.find((c) => c.id === m![2]);
      if (!card) return Response.json({ error: "no such card" }, { status: 404 });
      if (body.version !== card.version) return Response.json({ error: "stale", card }, { status: 409 });
      Object.assign(card, body, { version: card.version + 1 });
      return Response.json(card);
    }
    if ((m = url.pathname.match(/^\/api\/boards\/([^/]+)\/cards\/([^/]+)$/)) && req.method === "DELETE") return Response.json({ error: "not yours" }, { status: 403 });
    if (url.pathname === "/api/tokens") return Response.json({ token: "card-token", expires_at: "later" });
    if (url.pathname === "/api/tokens/revoke") return Response.json({ ok: true });
    if (url.pathname === "/api/fleet/environments") return Response.json([{ name: "laptop" }]);
    if (url.pathname.startsWith("/api/fleet/environments/") && req.method === "DELETE") return Response.json({ ok: true });
    if (url.pathname === "/api/spawns" && req.method === "GET") return Response.json(url.searchParams.get("state")!.startsWith("pending") ? [{ id: "s-open" }] : [{ id: "s-over" }]);
    if (url.pathname.startsWith("/api/spawns")) return Response.json({ id: "s-new" }, { status: 201 });
    if (url.pathname === "/api/sessions") return Response.json([{ id: "me" }, { id: "sealed-1", from: "worker" }, { id: "other" }]);
    if (url.pathname.endsWith("/say")) return Response.json({ ok: true });
    if (url.pathname.startsWith("/api/plans/")) return Response.json({ date: url.pathname.slice(11, 21), version: 3 });
    return Response.json({ error: `no route ${req.method} ${path}` }, { status: 404 });
  },
  websocket: {
    open(ws) {
      sockets.push(ws);
    },
    message(ws, m) {
      if (m === "ping") ws.send("pong");
      else said.push([ws.data.path, String(m)]);
    },
  },
});
afterAll(() => worker.stop(true));

const until = async (ok: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};
const socketsAt = (path: string) => sockets.filter((s) => s.data.path === path && s.readyState === 1);

function link(o: Partial<Link> = {}): Link {
  return {
    cloud: `http://127.0.0.1:${worker.port}`,
    token: async () => "tok",
    socket: (url, t) => new WebSocket(url, { headers: { Authorization: `Bearer ${t}` } } as any),
    environment: "laptop",
    remotes: async (root) => (root === "/home/me/proj" ? ["https://git.test/me/proj"] : []),
    machine: () => ({ host: "laptop" }),
    self: () => "me",
    ...o,
  };
}
const events = () => {
  const got: [string, any][] = [];
  return { got, listener: (key: string, event: unknown) => void got.push([key, event]) };
};

beforeEach(() => {
  asked.length = 0;
  answer = undefined;
});

describe("a session's boards, from the Worker", () => {
  it("follows a board that exists, telling the Worker its place, and null for one that doesn't", async () => {
    const cloud = new Cloud(link());
    const e = events();
    const s = new Session(cloud, e.listener);
    expect(await s.call("subscribe", ["nothing", "Nothing", "/home/me/nothing"])).toBeNull();
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual(["GET /api/boards/nothing/cards"]);
    expect(socketsAt("/api/boards/nothing/live")).toHaveLength(0);

    // make makes it, with its first commit and remotes, and answers the copy.
    expect(await s.call("subscribe", ["proj", "Proj", "/home/me/proj", true, "abc123"])).toEqual([]);
    expect(boards.get("proj")).toMatchObject({ name: "Proj", root: "/home/me/proj", environment: "laptop", commit: "abc123", remotes: ["https://git.test/me/proj"] });
    expect(asked.every((a) => a.auth === "Bearer tok")).toBe(true);
    await until(() => socketsAt("/api/boards/proj/live").length === 1);
    expect(socketsAt("/api/boards/proj/live")[0].data.auth).toBe("Bearer tok");
    socketsAt("/api/boards/proj/live")[0].send(JSON.stringify({ type: "card", card: { id: "TASK-1" } }));
    await until(() => e.got.length === 1);
    expect(e.got[0]).toEqual(["proj", { type: "card", card: { id: "TASK-1" } }]);
    s.close();
    await until(() => socketsAt("/api/boards/proj/live").length === 0);
  });

  it("shares one socket among the sessions on a board, closing it with the last", async () => {
    boards.set("shared", { cards: [] });
    const cloud = new Cloud(link());
    const a = events();
    const b = events();
    const one = new Session(cloud, a.listener);
    const two = new Session(cloud, b.listener);
    await one.call("subscribe", ["shared", "Shared"]);
    await two.call("subscribe", ["shared", "Shared"]);
    // No root: nothing told of its place.
    expect(asked.filter((x) => x.method === "PUT")).toEqual([]);
    await until(() => socketsAt("/api/boards/shared/live").length === 1);
    socketsAt("/api/boards/shared/live")[0].send(JSON.stringify({ type: "x" }));
    await until(() => a.got.length === 1 && b.got.length === 1);
    one.close();
    await Bun.sleep(50);
    expect(socketsAt("/api/boards/shared/live")).toHaveLength(1);
    expect(cloud.live.has("shared")).toBe(true);
    two.close();
    expect(cloud.live.has("shared")).toBe(false);
  });

  it("reconnects a dropped board with a whole fresh copy, and the user's socket with word of it", async () => {
    boards.set("drops", { cards: [{ id: "TASK-1", title: "kept", version: 1 }] });
    const cloud = new Cloud(link());
    const e = events();
    const s = new Session(cloud, e.listener);
    await s.call("subscribe", ["drops", "Drops"]);
    await s.call("plan_subscribe", []);
    await until(() => socketsAt("/api/boards/drops/live").length === 1 && socketsAt("/api/live").length === 1);
    socketsAt("/api/boards/drops/live")[0].close();
    socketsAt("/api/live")[0].close();
    await until(() => e.got.length === 2, 5000);
    expect(e.got).toContainEqual(["drops", { type: "snapshot", cards: [{ id: "TASK-1", title: "kept", version: 1 }] }]);
    expect(e.got).toContainEqual([USER, { type: "reconnected" }]);
    expect(socketsAt("/api/boards/drops/live")).toHaveLength(1);
    s.close();
  });

  it("gives up on a socket that won't open, so the next follow tries again", async () => {
    const cloud = new Cloud(link({ socket: () => new WebSocket(`ws://127.0.0.1:1/nothing`) }));
    boards.set("closed", { cards: [] });
    const s = new Session(cloud, () => {});
    await expect(s.call("subscribe", ["closed", "Closed"])).rejects.toThrow("can't follow board closed");
    expect(cloud.live.has("closed")).toBe(false);
  });

  it("says a page with no machine's clone is nowhere", async () => {
    const s = new Session(new Cloud(link({ environment: null })), () => {});
    await s.call("make", ["inpage", "In the page", "/in/memory"]);
    expect(boards.get("inpage")).toMatchObject({ name: "In the page", root: null, environment: null });
    expect(asked.find((a) => a.method === "PUT")!.body).not.toHaveProperty("remotes");
  });

  it("resolves a project's board by its first commit, the one made at its path first", async () => {
    boards.set("fork", { commit: "c0ffee", cards: [] });
    boards.set("upstream", { commit: "c0ffee", cards: [] });
    const s = new Session(new Cloud(link()), () => {});
    expect(await s.call("resolve", ["upstream", "c0ffee"])).toBe("upstream");
    expect(await s.call("resolve", ["home-me-new", "c0ffee"])).toBe("fork");
    expect(await s.call("resolve", ["home-me-new", "deadbeef"])).toBe("home-me-new");
    expect(asked.at(-1)!.path).toBe("/api/boards?commit=deadbeef");
  });

  it("answers a stale update with the card as it is, and throws what the Worker refuses", async () => {
    boards.set("cards", { cards: [] });
    const s = new Session(new Cloud(link()), () => {});
    const made = (await s.call("create", ["cards", { title: "One" }])) as { id: string };
    expect(await s.call("update", ["cards", made.id, 1, { title: "Two" }])).toEqual({ card: { id: made.id, title: "Two", version: 2 } });
    expect(await s.call("update", ["cards", made.id, 1, { title: "Three" }])).toEqual({ conflict: { id: made.id, title: "Two", version: 2 } });
    await expect(s.call("update", ["cards", "TASK-9", 1, {}])).rejects.toThrow("corkboard cloud: no such card");
    await expect(s.call("delete", ["cards", made.id])).rejects.toThrow("corkboard cloud: not yours");
    await expect(s.call("create", ["", {}])).rejects.toThrow("no board key");
    await expect(s.call("nonsense", ["cards"])).rejects.toThrow("no operation nonsense");
    expect(await s.call("token", ["cards", made.id, "fleet"])).toEqual({ token: "card-token", expires_at: "later", url: `http://127.0.0.1:${worker.port}/mcp` });
    expect(asked.at(-1)!.body).toEqual({ board: "cards", card: made.id, agent: "fleet" });
  });
});

describe("the fleet, from the Worker", () => {
  it("lists environments, spawns, this page's sessions and every other bridge, the sealed ones first", async () => {
    const sealed = { list: (self?: string) => (expect(self).toBe("me"), [{ id: "sealed-1", from: "hub" }]), has: () => false } as unknown as Peers;
    const s = new Session(new Cloud(link({ peers: () => sealed })), () => {}, () => [{ buf: 1 }]);
    expect(await s.call("fleet_get", [])).toEqual({
      environments: [{ name: "laptop" }],
      spawns: [{ id: "s-open" }, { id: "s-over" }],
      sessions: [{ buf: 1 }],
      bridges: [{ id: "sealed-1", from: "hub" }, { id: "other" }],
      self: "me",
      machine: { host: "laptop" },
    });
  });

  it("queues a session on a board, on the node's grant when asked", async () => {
    const s = new Session(new Cloud(link()), () => {});
    await s.call("fleet_session", ["laptop", "claude", "proj", true, "pepper"]);
    expect(asked.at(-1)).toMatchObject({ method: "POST", path: "/api/spawns", body: { environment: "laptop", template: "claude", interactive: true, task: "", board: "proj", node: true, brain: "pepper" } });
    await s.call("fleet_session", ["laptop", "claude"]);
    expect(asked.at(-1)!.body).toEqual({ environment: "laptop", template: "claude", interactive: true, task: "" });
    await s.call("fleet_stop", ["s 1"]);
    expect(asked.at(-1)!.path).toBe("/api/spawns/s%201/stop");
    // An environment that's gone, off the Worker's list.
    await s.call("fleet_forget", ["omni"]);
    expect(asked.at(-1)).toMatchObject({ method: "DELETE", path: "/api/fleet/environments/omni" });
    await expect(s.call("fleet_forget", ["../spawns"])).rejects.toThrow(/environment's name/);
  });

  it("follows a conversation on the Worker's socket until it ends, and stops when unfollowed", async () => {
    const e = events();
    const s = new Session(new Cloud(link()), e.listener);
    await expect(s.call("fleet_follow", ["../x", "y"])).rejects.toThrow("which session?");
    await s.call("fleet_follow", ["laptop-1", "1-2"]);
    await until(() => socketsAt("/api/sessions/laptop-1/1-2/attach").length === 1);
    const ws = socketsAt("/api/sessions/laptop-1/1-2/attach")[0];
    ws.send("not json");
    ws.send(JSON.stringify({ type: "out", data: JSON.stringify({ items: [{ text: "hi" }], reset: true, state: "working" }) }));
    ws.send(JSON.stringify({ type: "end", why: "that session has ended" }));
    ws.close();
    await until(() => e.got.length === 3);
    expect(e.got).toEqual([
      [USER, { type: "conversation", bridge: "laptop-1", key: "1-2", items: [{ text: "hi" }], reset: true, state: "working" }],
      [USER, { type: "conversation_end", bridge: "laptop-1", key: "1-2", why: "that session has ended" }],
      [USER, { type: "conversation_end", bridge: "laptop-1", key: "1-2", why: "no longer followed" }],
    ]);
    // Unfollowed, its socket's close says nothing.
    await s.call("fleet_follow", ["laptop-1", "3-4"]);
    await until(() => socketsAt("/api/sessions/laptop-1/3-4/attach").length === 1);
    await s.call("fleet_unfollow", ["laptop-1", "3-4"]);
    await until(() => socketsAt("/api/sessions/laptop-1/3-4/attach").length === 0);
    await Bun.sleep(50);
    expect(e.got).toHaveLength(3);
  });

  it("mirrors a terminal both ways, sending what's typed once its socket opens", async () => {
    const e = events();
    const s = new Session(new Cloud(link()), e.listener);
    await s.call("fleet_terminal", ["laptop-1", "5-6"]);
    // Typed before the socket is open.
    await s.call("fleet_terminal_send", ["laptop-1", "5-6", { type: "in", data: "eA" }]);
    await until(() => socketsAt("/api/sessions/laptop-1/5-6/attach?terminal").length === 1);
    const ws = socketsAt("/api/sessions/laptop-1/5-6/attach?terminal")[0];
    ws.send(JSON.stringify({ type: "out", data: "ZWNobw" }));
    await until(() => e.got.length === 1);
    expect(e.got[0]).toEqual([USER, { type: "terminal", bridge: "laptop-1", key: "5-6", data: "ZWNobw" }]);
    await until(() => said.length === 1);
    expect(said).toEqual([["/api/sessions/laptop-1/5-6/attach?terminal", JSON.stringify({ type: "in", data: "eA" })]]);
    await s.call("fleet_unterminal", ["laptop-1", "5-6"]);
    await until(() => socketsAt("/api/sessions/laptop-1/5-6/attach?terminal").length === 0);
  });

  it("says what's typed through the account's hubs where they have the bridge, else the Worker", async () => {
    const through: [string, string, string][] = [];
    const sealed = { has: (b: string) => b === "hubbed", fetch: async (b: string, path: string, init: RequestInit) => (through.push([b, path, String(init.body)]), Response.json({ ok: true })) } as unknown as Peers;
    const s = new Session(new Cloud(link({ peers: () => sealed })), () => {});
    await s.call("fleet_say", ["hubbed", "1-2", "go", ["enter"]]);
    expect(through).toEqual([["hubbed", "/api/sessions/hubbed/1-2/say", JSON.stringify({ text: "go", keys: ["enter"] })]]);
    await s.call("fleet_say", ["worker-bridge", "1-2", "", [], [{ picks: [0] }]]);
    expect(asked.at(-1)).toMatchObject({ path: "/api/sessions/worker-bridge/1-2/say", body: { answers: [{ picks: [0] }] } });
  });

  it("leaves the Worker's word on a bridge the account's hubs have to the hubs", async () => {
    let told: ((b: unknown) => void) | undefined;
    const sealed = { has: (b: string) => b === "hubbed", on: (fn: (b: unknown) => void) => ((told = fn), () => (told = undefined)) } as unknown as Peers;
    const e = events();
    const s = new Session(new Cloud(link({ peers: () => sealed })), e.listener);
    await s.call("fleet_subscribe", []);
    await until(() => socketsAt("/api/live").length >= 1);
    for (const ws of socketsAt("/api/live")) {
      ws.send(JSON.stringify({ type: "bridge", bridge: { id: "hubbed" } }));
      ws.send(JSON.stringify({ type: "bridge", bridge: { id: "elsewhere" } }));
    }
    told!({ id: "hubbed", sessions: [] });
    await until(() => e.got.length === 2);
    expect(e.got).toEqual([
      [USER, { type: "bridge", bridge: { id: "hubbed", sessions: [] } }],
      [USER, { type: "bridge", bridge: { id: "elsewhere" } }],
    ]);
    s.close();
    expect(told).toBeUndefined();
  });
});

describe("brains and plans, from the Worker", () => {
  it("answers a stale brain or hold with it as it is, and a stale plan with the plan", async () => {
    const s = new Session(new Cloud(link()), () => {});
    answer = (method, path) => {
      if (path === "/api/brains/pepper" && method === "PATCH") return Response.json({ error: "stale", brain: { name: "pepper", version: 2 } }, { status: 409 });
      if (path === "/api/holds/gh" && method === "PATCH") return Response.json({ error: "stale", hold: { name: "gh" } }, { status: 409 });
      if (path === "/api/brains/pepper" && method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/api/plans/2026-11-20/accept") return Response.json({ plan: { version: 4 } }, { status: 409 });
      if (path.startsWith("/api/notes?brain=pepper")) return Response.json([{ id: "n" }]);
      if (path === "/api/brains/x") return Response.json({ error: "no brain x" }, { status: 404 });
    };
    expect(await s.call("brains_update", ["pepper", { about: "x" }])).toEqual({ stale: { name: "pepper", version: 2 }, error: "stale" });
    expect(await s.call("brains_hold_update", ["gh", { about: "x" }])).toEqual({ stale: { name: "gh" }, error: "stale" });
    expect(await s.call("brains_archive", ["pepper"])).toBeNull();
    expect(await s.call("brains_notes", ["pepper"])).toEqual([{ id: "n" }]);
    expect(asked.at(-1)!.path).toBe("/api/notes?brain=pepper&limit=200");
    await expect(s.call("brains_update", ["x", {}])).rejects.toThrow("no brain x");
    expect(await s.call("plan_accept", ["2026-11-20", 3, []])).toEqual({ conflict: { version: 4 } });
    expect(await s.call("plan_get", ["2026-11-20"])).toEqual({ date: "2026-11-20", version: 3 });
    await expect(s.call("plan_get", ["tomorrow"])).rejects.toThrow("YYYY-MM-DD");
  });
});
