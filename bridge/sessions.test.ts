import { afterAll, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hosted, type Peer, type TerminalOut, answers, bridgeId, serve } from "./sessions";

// The Worker's user socket, as a bridge follows it (?bridge=), and its
// /api/sessions, served here on a port of their own.
type Sock = ServerWebSocket<{ url: URL; auth: string | null }>;
const sockets: Sock[] = [];
const heard: any[] = [];
let others: unknown[] = [];
const worker = Bun.serve<{ url: URL; auth: string | null }>({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, s) {
    const url = new URL(req.url);
    if (url.pathname === "/api/live") return s.upgrade(req, { data: { url, auth: req.headers.get("authorization") } }) ? undefined : new Response("no", { status: 400 });
    if (url.pathname === "/api/sessions") return Response.json(others);
    return new Response("no", { status: 404 });
  },
  websocket: {
    open: (ws) => void sockets.push(ws),
    message: (_ws, m) => void (m !== "ping" && heard.push(JSON.parse(String(m)))),
  },
});
const dir = mkdtempSync(join(tmpdir(), "corkboard-sessions-"));
afterAll(() => {
  worker.stop(true);
  rmSync(dir, { recursive: true, force: true });
});
const WORKER = { cloud: `http://127.0.0.1:${worker.port}`, token: async () => "tok" };

const until = async (ok: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error(`timed out; heard ${JSON.stringify(heard.slice(-3))}`);
    await Bun.sleep(20);
  }
};
const live = (bridge: string) => sockets.filter((s) => s.data.url.searchParams.get("bridge") === bridge && s.readyState === 1);
const told = (pred: (m: any) => boolean) => heard.find(pred);
const line = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, timestamp: "2026-11-20T10:00:00Z", message: { content: text } }) + "\n";

describe("answers to a session's question", () => {
  it("are a list of picks, with words of their own kept only when there are some", () => {
    expect(answers([{ picks: [0, 2], other: "  " }, { picks: [], other: "Bacon" }])).toEqual([{ picks: [0, 2] }, { picks: [], other: "Bacon" }]);
    expect(answers([])).toBe("answers must be a list, one for each question");
    expect(answers(Array(9).fill({ picks: [] }))).toBe("answers must be a list, one for each question");
    expect(answers([{ picks: [1.5] }])).toBe("each answer needs picks, the options' numbers from 0");
    expect(answers([{ picks: Array(17).fill(0) }])).toBe("each answer needs picks, the options' numbers from 0");
    expect(answers([{ picks: [], other: "x".repeat(2001) }])).toBe("other must be a string, under 2000 characters");
    expect(bridgeId("matt's laptop/dev")).toBe("matt-s-laptop-dev");
  });
});

describe("a bridge's sessions, through the Worker", () => {
  const transcript = join(dir, "a.jsonl");
  writeFileSync(transcript, line("u1", "first") + line("u2", "second"));
  let sessions: Hosted[] = [
    { key: "1-2", name: "Fixing", state: "working", project: "proj", transcript },
    { key: "3-4", name: "Waiting", state: "idle" },
  ];
  const watchers: (() => void)[] = [];
  const typed: unknown[] = [];
  const term: unknown[] = [];
  let to: TerminalOut | undefined;
  let peers: Peer[][] = [];
  serve(
    "laptop-1",
    "laptop",
    {
      list: () => sessions,
      watch: (fn) => void watchers.push(fn),
      say: async (key, text, keys, a) => (typed.push(a ? [key, a] : [key, text, keys]), { ok: true }),
      screen: async (key) => ({ lines: [`screen of ${key}`] }),
      speech: async (sentence) => ({ rate: 24000, said: sentence }),
      terminals: (t) => ((to = t), { open: (s, k) => term.push(["open", s, k]), input: (s, d) => term.push(["in", s, d]), size: (s, r, c, f) => term.push(["size", s, r, c, f]), close: (s) => term.push(["close", s]) }),
      peers: (b) => void peers.push(b),
    },
    WORKER,
  );
  const send = (m: object) => live("laptop-1")[0].send(JSON.stringify(m));

  it("follows the user's socket as the bridge, and says its sessions at once and on each change, logs kept here", async () => {
    await until(() => live("laptop-1").length === 1);
    const ws = live("laptop-1")[0];
    expect(ws.data.auth).toBe("Bearer tok");
    expect(ws.data.url.searchParams.get("machine")).toBeTruthy();
    await until(() => !!told((m) => m.type === "sessions"));
    expect(told((m) => m.type === "sessions")).toEqual({
      type: "sessions",
      environment: "laptop",
      sessions: [
        { key: "1-2", name: "Fixing", state: "working", project: "proj", attach: true, terminal: true },
        { key: "3-4", name: "Waiting", state: "idle", attach: false, terminal: true },
      ],
    });
    heard.length = 0;
    sessions = [{ ...sessions[0], state: "asking" }, sessions[1]];
    watchers.forEach((fn) => fn());
    await until(() => heard.length === 1);
    expect(heard[0].sessions[0].state).toBe("asking");
  });

  it("answers what's asked of a session: its screen, its voice, what's typed and answers to its question", async () => {
    heard.length = 0;
    send({ type: "screen", ask: 1, key: "1-2" });
    send({ type: "speech", ask: 2, key: "1-2", sentence: "Hi." });
    send({ type: "say", ask: 3, key: "1-2", text: "go", keys: ["enter"] });
    send({ type: "say", ask: 4, key: "1-2", answers: [{ picks: [1], other: "" }] });
    send({ type: "say", ask: 5, key: "1-2", answers: [{ picks: [-1] }] });
    send({ type: "say", ask: 6, key: 7 });
    // Not a question: no ask.
    send({ type: "screen", key: "1-2" });
    await until(() => heard.length === 6);
    const by = (ask: number) => heard.find((m) => m.ask === ask);
    expect(by(1)).toEqual({ type: "answer", ask: 1, lines: ["screen of 1-2"] });
    expect(by(2)).toEqual({ type: "answer", ask: 2, rate: 24000, said: "Hi." });
    expect(by(3)).toEqual({ type: "answer", ask: 3, ok: true });
    expect(by(5)).toEqual({ type: "answer", ask: 5, error: "each answer needs picks, the options' numbers from 0" });
    expect(by(6)).toEqual({ type: "answer", ask: 6, error: "which session?" });
    expect(typed).toEqual([
      ["1-2", "go", ["enter"]],
      ["1-2", [{ picks: [1] }]],
    ]);
  });

  it("streams a conversation from its log: the last of it, each item as it grows, and over again for a new log", async () => {
    heard.length = 0;
    send({ type: "attach", stream: "s1", key: "1-2" });
    await until(() => heard.length === 1);
    const first = JSON.parse(heard[0].data);
    expect(heard[0]).toMatchObject({ type: "out", stream: "s1" });
    expect(first).toMatchObject({ reset: true, state: "asking", items: [{ kind: "you", text: "first" }, { kind: "you", text: "second" }] });
    appendFileSync(transcript, line("u3", "third"));
    await until(() => heard.length === 2);
    expect(JSON.parse(heard[1].data)).toEqual({ items: [{ id: "u3", at: "2026-11-20T10:00:00Z", kind: "you", text: "third" }] });
    // A /clear: a new log.
    const next = join(dir, "b.jsonl");
    writeFileSync(next, line("v1", "fresh"));
    sessions = [{ ...sessions[0], transcript: next, state: "working" }, sessions[1]];
    await until(() => heard.length === 3);
    expect(JSON.parse(heard[2].data)).toMatchObject({ reset: true, state: "working", items: [{ text: "fresh" }] });
    // One with no log but a screen has no conversation here.
    send({ type: "attach", stream: "s2", key: "3-4" });
    await until(() => heard.length === 4);
    expect(heard[3]).toEqual({ type: "end", stream: "s2", why: "that session has no conversation here" });
    // It ends with its session.
    sessions = [sessions[1]];
    await until(() => heard.length === 5);
    expect(heard[4]).toEqual({ type: "end", stream: "s1", why: "that session has ended" });
  });

  it("mirrors a terminal both ways, and lets go of it when detached", async () => {
    heard.length = 0;
    send({ type: "attach", stream: "t1", key: "3-4", terminal: true });
    await until(() => term.length === 1);
    // A stream that's taken can't be attached again.
    send({ type: "attach", stream: "t1", key: "3-4" });
    send({ type: "in", stream: "t1", data: "eA" });
    send({ type: "size", stream: "t1", rows: 24, cols: 80, focus: true });
    // Another's stream isn't this one's to type into.
    send({ type: "in", stream: "nope", data: "x" });
    await until(() => term.length === 3);
    to!.out("t1", "ZWNobw");
    await until(() => heard.length === 1);
    expect(heard[0]).toEqual({ type: "out", stream: "t1", data: "ZWNobw" });
    send({ type: "detach", stream: "t1" });
    await until(() => heard.length === 2);
    expect(heard[1]).toEqual({ type: "end", stream: "t1" });
    expect(term).toEqual([
      ["open", "t1", "3-4"],
      ["in", "t1", "eA"],
      ["size", "t1", 24, 80, true],
      ["close", "t1"],
    ]);
  });

  it("tells of every other bridge, from the list and then each change, and drops its streams when the socket goes, coming back", async () => {
    // What it looked up when its socket opened: every bridge but itself.
    others = [
      { id: "laptop-1", machine: "laptop", sessions: [] },
      { id: "dev", machine: "laptop", sessions: [{ key: "9-9", name: "Dev", state: "idle" }] },
    ];
    peers = [];
    // The socket goes: its streams with it, and it comes back and looks again.
    send({ type: "attach", stream: "t2", key: "3-4", terminal: true });
    await until(() => term.length === 5);
    live("laptop-1")[0].close();
    await until(() => term.length === 6);
    expect(term.at(-1)).toEqual(["close", "t2"]);
    await until(() => live("laptop-1").length === 1, 8000);
    await until(() => peers.length >= 1);
    expect(peers.at(-1)!.map((b) => b.id)).toEqual(["dev"]);
    send({ type: "bridge", bridge: { id: "phone-bridge", machine: "x", sessions: [] } });
    send({ type: "bridge", bridge: { id: "dev", gone: true } });
    send({ type: "bridge", bridge: { id: "laptop-1", machine: "laptop", sessions: [] } });
    await until(() => peers.at(-1)!.length === 1 && peers.at(-1)![0].id === "phone-bridge");
  }, 15_000);
});
