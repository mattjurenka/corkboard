import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownerToken, worker } from "./login";

// A bridge's sessions on the live socket, and the phone's questions of them
// relayed to it (user.ts's bridges).

let owner: string;
beforeEach(async () => {
  owner = await ownerToken();
});
afterEach(async () => {
  await reset();
});

function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${owner}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return worker(path, { ...init, headers });
}

async function listen(query = "") {
  const res = await api(`/api/live${query}`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const events: any[] = [];
  ws.addEventListener("message", (e) => void events.push(JSON.parse(e.data as string)));
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { ws, events, until };
}

const SESSION = { key: "1-7", project: "corkboard", name: "fleet work", state: "asking", since: 1, detail: "Which one?", mine: true };

describe("sessions", () => {
  it("lists a bridge's sessions while it's connected, and tells the phone", async () => {
    const phone = await listen();
    const bridge = await listen("?bridge=desk-7777&machine=desk");
    bridge.ws.send(JSON.stringify({ type: "sessions", environment: "local", sessions: [SESSION] }));
    await phone.until(() => phone.events.some((e) => e.type === "bridge"));
    expect(phone.events.find((e) => e.type === "bridge").bridge).toMatchObject({ id: "desk-7777", machine: "desk", sessions: [{ key: "1-7", state: "asking" }] });
    const list = await (await api("/api/sessions")).json<any[]>();
    expect(list).toHaveLength(1);
    expect(list[0].sessions[0]).not.toHaveProperty("mine");

    bridge.ws.close();
    await phone.until(() => phone.events.some((e) => e.bridge?.gone));
    expect(await (await api("/api/sessions")).json()).toEqual([]);
    phone.ws.close();
  });

  it("relays the screen and what's typed to the bridge, and its answer back", async () => {
    const bridge = await listen("?bridge=desk-7777&machine=desk");
    bridge.ws.addEventListener("message", (e) => {
      const q = JSON.parse(e.data as string);
      if (q.type === "screen") bridge.ws.send(JSON.stringify({ type: "answer", ask: q.ask, lines: [`session ${q.key}`], width: 80 }));
      if (q.type === "say") bridge.ws.send(JSON.stringify(q.key === "1-7" ? { type: "answer", ask: q.ask, ok: true } : { type: "answer", ask: q.ask, error: "that session has ended", missing: true }));
    });
    const screen = await api("/api/sessions/desk-7777/1-7");
    expect(await screen.json()).toEqual({ lines: ["session 1-7"], width: 80 });

    const say = (key: string, body: unknown) => api(`/api/sessions/desk-7777/${key}/say`, { method: "POST", body: JSON.stringify(body) });
    expect((await say("1-7", { text: "yes", keys: ["enter"] })).status).toBe(200);
    expect(bridge.events.find((e) => e.type === "say")).toMatchObject({ key: "1-7", text: "yes", keys: ["enter"] });
    expect((await say("1-8", { text: "yes" })).status).toBe(404);
    expect((await say("1-7", { keys: ["rm -rf"] })).status).toBe(400);
    expect((await say("1-7", {})).status).toBe(400);
    bridge.ws.close();

    expect((await api("/api/sessions/elsewhere-1/1-7")).status).toBe(404);
  });

  it("relays a stream to the phone, and keeps the fleet's events off it", async () => {
    const bridge = await listen("?bridge=desk-7777&machine=desk");
    const res = await api("/api/sessions/desk-7777/1-7/attach", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const phone = res.webSocket!;
    phone.accept();
    const got: any[] = [];
    phone.addEventListener("message", (e) => void got.push(JSON.parse(e.data as string)));

    await bridge.until(() => bridge.events.some((e) => e.type === "attach"));
    const attach = bridge.events.find((e) => e.type === "attach");
    expect(attach).toMatchObject({ key: "1-7" });

    bridge.ws.send(JSON.stringify({ type: "sessions", sessions: [SESSION] }));
    bridge.ws.send(JSON.stringify({ type: "out", stream: attach.stream, data: JSON.stringify({ items: [] }) }));
    bridge.ws.send(JSON.stringify({ type: "out", stream: "someone-else", data: btoa("not this") }));
    bridge.ws.send(JSON.stringify({ type: "end", stream: attach.stream, why: "exited" }));
    for (let i = 0; i < 100 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ type: "out", data: JSON.stringify({ items: [] }) }, { type: "end", why: "exited" }]);
    bridge.ws.close();
  });

  it("refuses a terminal on a bridge that isn't there", async () => {
    expect((await api("/api/sessions/gone-1/1-7/attach", { headers: { Upgrade: "websocket" } })).status).toBe(404);
  });
});

describe("opening a board on a bridge's page", () => {
  const post = async (path: string, body: unknown) => {
    const res = await api(path, { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, json: await res.json<any>() };
  };
  const remotes = ["git@github.com:matthew/corkboard.git"];

  async function served(url = "https://droplet.test:8443") {
    const bridge = await listen(`?bridge=droplet-7790&machine=droplet&url=${encodeURIComponent(url)}`);
    bridge.ws.send(JSON.stringify({ type: "sessions", environment: "cloud", sessions: [] }));
    for (let i = 0; i < 100 && !(await (await api("/api/sessions")).json<any[]>()).length; i++) await new Promise((r) => setTimeout(r, 10));
    return bridge;
  }

  it("gives a ticket the bridge redeems once, for its clone or the remotes", async () => {
    await api("/api/boards/corkboard", { method: "PUT", body: JSON.stringify({ root: "/home/matthew/corkboard", environment: "laptop", remotes }) });
    const bridge = await served();
    expect((await api("/api/sessions").then((r) => r.json<any[]>()))[0].url).toBe("https://droplet.test:8443");

    const made = await post("/api/workspace/tickets", { bridge: "droplet-7790", board: "corkboard" });
    expect(made.status).toBe(201);
    const ticket = new URL(made.json.url).searchParams.get("ticket")!;
    expect(made.json.url).toBe(`https://droplet.test:8443/open?ticket=${ticket}`);

    expect((await post("/api/workspace/redeem", { bridge: "elsewhere-1", ticket })).status).toBe(403);
    // Not cloned in the bridge's environment: the laptop's path is no use there.
    expect(await post("/api/workspace/redeem", { bridge: "droplet-7790", ticket })).toEqual({
      status: 200,
      json: { key: "corkboard", name: "corkboard", root: null, remotes },
    });
    expect((await post("/api/workspace/redeem", { bridge: "droplet-7790", ticket })).status).toBe(403);

    // Once it's cloned there, its clone.
    await api("/api/boards/corkboard", { method: "PUT", body: JSON.stringify({ root: "/home/workspace/src/corkboard", environment: "cloud" }) });
    const again = new URL((await post("/api/workspace/tickets", { bridge: "droplet-7790", board: "corkboard" })).json.url).searchParams.get("ticket");
    expect((await post("/api/workspace/redeem", { bridge: "droplet-7790", ticket: again })).json.root).toBe("/home/workspace/src/corkboard");
    bridge.ws.close();
  });

  it("refuses a bridge with no page, and a board that isn't there", async () => {
    await api("/api/boards/corkboard", { method: "PUT", body: JSON.stringify({}) });
    const plain = await listen("?bridge=desk-7777&machine=desk");
    plain.ws.send(JSON.stringify({ type: "sessions", sessions: [] }));
    await new Promise((r) => setTimeout(r, 50));
    expect((await post("/api/workspace/tickets", { bridge: "desk-7777", board: "corkboard" })).status).toBe(404);
    const bridge = await served("javascript:alert(1)");
    expect((await post("/api/workspace/tickets", { bridge: "droplet-7790", board: "corkboard" })).status).toBe(404);
    expect((await post("/api/workspace/tickets", { bridge: "droplet-7790", board: "typo" })).status).toBe(404);
    plain.ws.close();
    bridge.ws.close();
  });
});
