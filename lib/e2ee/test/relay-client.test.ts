import { afterEach, describe, expect, it, jest } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { PING_MS, SILENT_MS, wsLink } from "../channel";
import { Relay } from "../relay";
import { type Snapshot, type WireOp, b64url, fromB64url, fromUtf8 } from "../wire";

const TOKEN = { token: "tok", expires: Date.now() + 3_600_000 };
const op = (pos: number): WireOp => ({ id: `op${pos}`.padEnd(22, "x"), device: "d", seq: pos, pos, nonce: "n", ciphertext: "c", ts: "" });
const until = async (ok: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

// A relay's /e2ee/log/:object/live, served here on a port of its own: each
// socket's since, and what to do with it once open.
type Live = { since: number; owner: string | null; bearer: string; ws: ServerWebSocket<unknown> };
function liveRelay(port = 0, onOpen: (l: Live, n: number) => void = () => {}) {
  const opened: Live[] = [];
  const server: Server<{ since: number; owner: string | null; bearer: string }> = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, s) {
      const url = new URL(req.url);
      if (!/^\/e2ee\/log\/[^/]+\/live$/.test(url.pathname)) return new Response("no", { status: 404 });
      const bearer = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith("corkboard.bearer."));
      const data = { since: Number(url.searchParams.get("since")), owner: url.searchParams.get("owner"), bearer: bearer ? fromUtf8(fromB64url(bearer.slice(17))) : "" };
      return s.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": "corkboard" } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        const l = { ...ws.data, ws };
        opened.push(l);
        onOpen(l, opened.length);
      },
      message() {},
    },
  });
  return { server, opened };
}

const servers: Server<any>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

describe("following a log", () => {
  it("reconnects after a drop from the last op it saw, and after the relay comes back, until stopped", async () => {
    const got: [number[], Snapshot | undefined][] = [];
    const first = liveRelay(0, (l, n) => {
      if (n !== 1) return;
      l.ws.send(JSON.stringify({ ops: [op(3), op(4)] }));
      // Nothing to say isn't news.
      l.ws.send(JSON.stringify({ ops: [] }));
      l.ws.send(JSON.stringify({ snapshot: { upTo: 9, epoch: 0, nonce: "n", ciphertext: "c" } }));
      // The relay drops it.
      setTimeout(() => l.ws.close(1011, "restarting"), 50);
    });
    servers.push(first.server);
    const port = first.server.port!;
    const relay = new Relay({ origin: `http://127.0.0.1:${port}`, token: TOKEN });
    const stop = relay.subscribe("obj", 2, (ops, snapshot) => got.push([ops.map((o) => o.pos), snapshot]));

    await until(() => first.opened.length === 2);
    expect(first.opened.map((l) => [l.since, l.bearer, l.owner])).toEqual([
      [2, "tok", null],
      [9, "tok", null],
    ]);
    expect(got).toEqual([
      [[3, 4], undefined],
      [[], { upTo: 9, epoch: 0, nonce: "n", ciphertext: "c" }],
    ]);

    // The relay goes away altogether, and comes back on the same port.
    first.opened[1].ws.send(JSON.stringify({ ops: [op(12)] }));
    await until(() => got.length === 3);
    first.server.stop(true);
    servers.pop();
    await Bun.sleep(2500);
    const back = liveRelay(port, (l) => l.ws.send(JSON.stringify({ ops: [op(13)] })));
    servers.push(back.server);
    await until(() => back.opened.length === 1);
    expect(back.opened[0].since).toBe(12);
    await until(() => got.length === 4);
    expect(got[3][0]).toEqual([13]);

    // Stopped, it doesn't come back.
    stop();
    await Bun.sleep(2500);
    expect(back.opened.length).toBe(1);
  }, 20_000);

  it("follows another account's shared log by its owner", async () => {
    const r = liveRelay();
    servers.push(r.server);
    const relay = new Relay({ origin: `http://127.0.0.1:${r.server.port}`, token: TOKEN });
    const stop = relay.shares("owner-acct").subscribe!("obj", 0, () => {});
    await until(() => r.opened.length === 1);
    expect(r.opened[0].owner).toBe("owner-acct");
    stop();
  });
});

// A socket that's open, for links over it: what's sent, and events by hand.
class FakeSocket extends EventTarget {
  readyState = 1;
  binaryType = "blob";
  sent: unknown[] = [];
  closes: number[] = [];
  constructor(readonly url = "", readonly protocols: string[] = []) {
    super();
  }
  send(b: unknown) {
    this.sent.push(b);
  }
  close(code = 1000) {
    this.closes.push(code);
    this.readyState = 3;
  }
  hear(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  drop(code: number, reason = "") {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}
const asSocket = (s: FakeSocket) => s as unknown as WebSocket;

describe("a channel's socket", () => {
  afterEach(() => jest.useRealTimers());

  it("pings while the relay answers, and ends once it has said nothing for SILENT_MS", () => {
    jest.useFakeTimers();
    const ws = new FakeSocket();
    const link = wsLink(asSocket(ws));
    const ended: string[] = [];
    const bytes: number[][] = [];
    link.on((b) => bytes.push([...b]), (why) => ended.push(why));
    jest.advanceTimersByTime(PING_MS);
    expect(ws.sent).toEqual(["ping"]);
    ws.hear("pong");
    ws.hear(Uint8Array.of(1, 2).buffer);
    expect(bytes).toEqual([[1, 2]]);
    // Heard from just now: still alive past SILENT_MS from the start.
    jest.advanceTimersByTime(SILENT_MS - PING_MS);
    expect(ended).toEqual([]);
    expect(ws.sent.length).toBeGreaterThan(1);
    jest.advanceTimersByTime(SILENT_MS);
    expect(ended).toEqual(["the relay stopped answering"]);
    expect(ws.closes).toEqual([1000]);
    // Its close event, when it comes, ends nothing again.
    ws.drop(1006);
    expect(ended).toHaveLength(1);
    // Nor does it ping any more.
    const sent = ws.sent.length;
    jest.advanceTimersByTime(PING_MS * 3);
    expect(ws.sent.length).toBe(sent);
  });

  it("ends with the close event's reason, even for one listening only after", () => {
    const ws = new FakeSocket();
    const link = wsLink(asSocket(ws));
    ws.drop(4001, "the device went away");
    const ended: string[] = [];
    link.on(() => {}, (why) => ended.push(why));
    expect(ended).toEqual(["the device went away"]);
    const other = new FakeSocket();
    const l2 = wsLink(asSocket(other));
    const e2: string[] = [];
    l2.on(() => {}, (why) => e2.push(why));
    other.drop(1006);
    expect(e2).toEqual(["the relay closed it (1006)"]);
    // A closed socket isn't sent to.
    l2.send(Uint8Array.of(1));
    expect(other.sent).toEqual([]);
  });
});

describe("a node's socket", () => {
  afterEach(() => jest.useRealTimers());

  it("ends once the relay has said nothing for SILENT_MS, and connects again; but not when replaced", async () => {
    jest.useFakeTimers();
    const made: FakeSocket[] = [];
    const states: boolean[] = [];
    const relay = new Relay({ origin: "https://relay.test", token: TOKEN, socket: (url, protocols) => (made.push(new FakeSocket(url, protocols)), asSocket(made.at(-1)!)) });
    const stop = relay.serveTunnel(async () => new Response("hi"), { name: "laptop", onState: (s) => states.push(s) });
    await Promise.resolve();
    await Promise.resolve();
    expect(made).toHaveLength(1);
    expect(made[0].url).toBe("wss://relay.test/e2ee/nodes/live?name=laptop");
    expect(made[0].protocols).toEqual(["corkboard", `corkboard.bearer.${b64url(new TextEncoder().encode("tok"))}`]);
    made[0].dispatchEvent(new Event("open"));
    expect(states).toEqual([true]);
    jest.advanceTimersByTime(PING_MS);
    expect(made[0].sent).toEqual(["ping"]);
    made[0].hear("pong");
    jest.advanceTimersByTime(SILENT_MS);
    expect(states).toEqual([true]);
    jest.advanceTimersByTime(SILENT_MS);
    expect(states).toEqual([true, false]);
    expect(made[0].closes).toHaveLength(1);
    // Again, two seconds on.
    jest.advanceTimersByTime(2000);
    await Promise.resolve();
    await Promise.resolve();
    expect(made).toHaveLength(2);
    made[1].dispatchEvent(new Event("open"));
    // Replaced by another socket of this device's (4000): it stays down.
    made[1].drop(4000, "replaced");
    expect(states).toEqual([true, false, true, false]);
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(made).toHaveLength(2);
    stop();
  });
});
