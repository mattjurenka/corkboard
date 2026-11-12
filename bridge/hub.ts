// A machine's sessions, served on the sealed channels the account's devices
// open to it (.agent/plans/ciphertext-relay.md, step 3): what the Worker's
// User DO does for sessions (its user.ts, "Bridges"), done here, so the
// relay carries them as ciphertext. The machine's bridges join it (the
// node's, on loopback: server.ts's /app/sessions; fleetd's, in its
// process), speaking what they speak to the Worker's /api/live?bridge=
// (sessions.ts): they say what sessions they have, answer what's asked,
// and send a stream's conversation or terminal down it. A watcher (the
// phone, Neovim's fleet view) asks for them at the Worker's own paths:
//
//   GET  /api/sessions[?follow]          the bridges and their sessions; ?follow,
//                                        ndjson: { type: "bridges", bridges }, then
//                                        each { type: "bridge", bridge } as it changes
//   GET  /api/sessions/:b/:k             its screen
//   POST /api/sessions/:b/:k/say         { text, keys } or { answers }
//   POST /api/sessions/:b/:k/speech      a sentence, in its face's voice: 16-bit samples
//   GET|POST /api/sessions/:b/:k/attach[?terminal]
//                                        ndjson both ways: { type: "out", data } and
//                                        { type: "end", why } back; { type: "in", data }
//                                        and { type: "size", rows, cols, focus } in
//
// Nothing's kept: a bridge's list is the hub's while it's joined.

import { answers, type HubJoin, type Link } from "./sessions";

// A bridge in this process joining hub.
export const joinHub =
  (hub: Hub): HubJoin =>
  (hello, connect) => {
    let link: Link | undefined;
    const j = hub.join(hello, (m) => link?.receive(m));
    link = connect((m) => j.receive(m));
  };

// The Worker's (cloud/src/api.ts's).
const KEYS = ["enter", "esc", "up", "down", "tab", "shift-tab", "ctrl-c"];
const BRIDGE = /^[\w-]{1,64}$/;
const KEY = /^[\w.-]{1,64}$/;

export type HubBridge = {
  id: string;
  machine: string;
  url: string | null;
  environment: string | null;
  sessions: Record<string, unknown>[];
  // Its machine, as host.ts looks at it, where the bridge says.
  host?: Record<string, unknown>;
};
export type Hello = {
  id: string;
  machine: string;
  url?: string | null;
  environment?: string | null;
};
// A bridge's end of its link: what it says goes to receive, and drop is
// the link ending.
export type Joined = { receive(m: any): void; drop(): void };

type Sink = { out(data: string): void; end(why: string | null): void };
type Member = {
  b: HubBridge | null;
  hello: Hello;
  send(m: object): void;
  asks: Map<number, (a: Record<string, any>) => void>;
  streams: Map<string, Sink>;
};
type Result = { status: number; value: Record<string, any> };

const str = (x: unknown, n = 128) => (typeof x === "string" ? x.slice(0, n) : null);
const num = (x: unknown) => (Number.isFinite(x) ? (x as number) : null);
// A machine's look (host.ts's Host), if it's a small enough object.
const look = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) && JSON.stringify(v).length <= 8192 ? (v as Record<string, unknown>) : undefined);
// The Worker's bridgeSession.
const session = (v: unknown) => {
  const s = (v ?? {}) as Record<string, unknown>;
  return {
    key: typeof s.key === "string" && KEY.test(s.key) ? s.key : "",
    spawn: str(s.spawn, 20),
    project: str(s.project) ?? "",
    name: str(s.name) ?? "Claude Code",
    state: str(s.state, 32) ?? "",
    since: num(s.since),
    detail: str(s.detail, 2000),
    typed: num(s.typed),
    host: str(s.host, 64),
    vm: str(s.vm, 64),
    role: str(s.role, 32),
    card: str(s.card, 32),
    context: num(s.context),
    attach: s.attach === true,
    terminal: s.terminal === true,
    persona: str(s.persona, 32),
    skin: str(s.skin, 16),
  };
};

export class Hub {
  private members = new Map<string, Member>();
  private followers = new Set<(e: object) => void>();
  private nextAsk = 1;

  // One link a bridge: a new one takes over.
  join(hello: Hello, send: (m: object) => void): Joined {
    if (!BRIDGE.test(hello.id)) throw new Error(`bad bridge id ${hello.id}`);
    this.members.get(hello.id) && this.leave(this.members.get(hello.id)!, "the bridge connected again");
    const me: Member = {
      b: null,
      hello,
      send,
      asks: new Map(),
      streams: new Map(),
    };
    this.members.set(hello.id, me);
    return {
      receive: (m) => this.members.get(hello.id) === me && this.heard(me, m),
      drop: () => this.members.get(hello.id) === me && this.leave(me, "the bridge went away"),
    };
  }

  private leave(me: Member, why: string) {
    this.members.delete(me.hello.id);
    for (const a of me.asks.values()) a({ error: why });
    for (const s of me.streams.values()) s.end(why);
    me.streams.clear();
    if (me.b) this.tell({ type: "bridge", bridge: { id: me.hello.id, gone: true } });
  }

  private heard(me: Member, m: any) {
    if (m?.type === "sessions" && Array.isArray(m.sessions)) {
      me.b = {
        id: me.hello.id,
        machine: (me.hello.machine ?? "").slice(0, 64),
        url: me.hello.url && /^https:\/\/[\w.-]+(:\d+)?$/.test(me.hello.url) ? me.hello.url : null,
        environment: str(m.environment ?? me.hello.environment, 64),
        sessions: m.sessions
          .slice(0, 64)
          .map(session)
          .filter((s: { key: string }) => s.key),
        ...(look(m.host) && { host: look(m.host) }),
      };
      this.tell({ type: "bridge", bridge: me.b });
    } else if (m?.type === "answer" && typeof m.ask === "number") me.asks.get(m.ask)?.(m);
    else if (m?.type === "out" && typeof m.data === "string") me.streams.get(m.stream)?.out(m.data);
    else if (m?.type === "end") {
      const s = me.streams.get(m.stream);
      me.streams.delete(m.stream);
      s?.end(str(m.why, 200));
    }
  }

  private tell(e: object) {
    for (const fn of this.followers) fn(e);
  }

  bridges(): HubBridge[] {
    return [...this.members.values()].flatMap((m) => (m.b ? [m.b] : [])).sort((a, b) => a.id.localeCompare(b.id));
  }

  // Each change to the bridges, as the Worker's live socket says it.
  follow(fn: (e: object) => void): () => void {
    this.followers.add(fn);
    return () => void this.followers.delete(fn);
  }

  // A question for a bridge, answered by it or, after a while, refused.
  async ask(bridge: string, q: Record<string, unknown>): Promise<Result> {
    const me = this.members.get(bridge);
    if (!me?.b)
      return {
        status: 404,
        value: { error: `bridge ${bridge} isn't connected` },
      };
    const id = this.nextAsk++;
    const a = await new Promise<Record<string, any>>((resolve) => {
      me.asks.set(id, resolve);
      // A voice can take a minute or more to start (Chatterbox's).
      setTimeout(() => resolve({ error: "the bridge didn't answer" }), q.type === "speech" ? 90_000 : 10_000);
      try {
        me.send({ ...q, ask: id });
      } catch {
        resolve({ error: "the bridge went away" });
      }
    }).finally(() => me.asks.delete(id));
    if (typeof a.error === "string")
      return {
        status: a.missing ? 404 : 502,
        value: { error: a.error.slice(0, 500) },
      };
    if (q.type === "speech") {
      if (typeof a.audio !== "string" || !Number.isFinite(a.rate)) return { status: 502, value: { error: "the bridge said no sentence" } };
      return { status: 200, value: a };
    }
    if (q.type !== "screen") return { status: 200, value: { ok: true } };
    const lines = Array.isArray(a.lines) ? a.lines.slice(-300).map((l: unknown) => String(l).slice(0, 1000)) : [];
    return {
      status: 200,
      value: {
        lines,
        width: num(a.width),
        ...(Array.isArray(a.colors) && {
          colors: a.colors.slice(-lines.length),
        }),
        ...(Array.isArray(a.palette) && a.palette.length === 16 && { palette: a.palette }),
      },
    };
  }

  // A stream of one session's conversation, or of its terminal.
  attach(
    bridge: string,
    key: string,
    terminal: boolean,
    sink: Sink,
  ):
    | {
        input(data: string): void;
        size(rows: number, cols: number, focus: boolean): void;
        close(): void;
      }
    | undefined {
    const me = this.members.get(bridge);
    if (!me?.b) return undefined;
    const stream = crypto.randomUUID();
    me.streams.set(stream, sink);
    me.send({
      type: "attach",
      stream,
      key,
      ...(terminal && { terminal: true }),
    });
    const live = () => me.streams.has(stream) && this.members.get(bridge) === me;
    return {
      input: (data) => live() && data.length <= 65536 && me.send({ type: "in", stream, data }),
      size: (rows, cols, focus) => live() && Number.isInteger(rows) && Number.isInteger(cols) && me.send({ type: "size", stream, rows, cols, focus }),
      close: () => {
        if (!live()) return;
        me.streams.delete(stream);
        me.send({ type: "detach", stream });
      },
    };
  }

  // The watchers' HTTP, at the Worker's paths; undefined for any other path.
  async serve(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/api\/sessions(?:\/([^/]+)\/([^/]+)(?:\/(say|speech|attach))?)?$/);
    if (!m) return undefined;
    const [, bridge, key, op] = m;
    const error = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
    const reply = (r: Result) =>
      Response.json(r.value, {
        status: r.status,
        headers: { "Cache-Control": "no-store" },
      });
    if (bridge && !(BRIDGE.test(bridge) && KEY.test(key))) return error(404, "not found");
    const body = async () => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, any>;

    if (!bridge) {
      if (req.method !== "GET") return error(405, "method not allowed");
      if (!url.searchParams.has("follow"))
        return Response.json(this.bridges(), {
          headers: { "Cache-Control": "no-store" },
        });
      let off = () => {};
      return ndjson((send) => {
        send({ type: "bridges", bridges: this.bridges() });
        off = this.follow(send);
        return () => off();
      });
    }
    if (op === "attach") return this.stream(req, bridge, key, url.searchParams.has("terminal"));
    if (!op) return req.method === "GET" ? reply(await this.ask(bridge, { type: "screen", key })) : error(405, "method not allowed");
    if (req.method !== "POST") return error(405, "method not allowed");
    if (op === "speech") {
      const r = await this.ask(bridge, {
        type: "speech",
        key,
        sentence: await body(),
      });
      if (r.status !== 200) return reply(r);
      const { audio, rate, phonemes, frames } = r.value;
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "x-sample-rate": String(rate),
        "x-format": "s16",
      };
      if (typeof phonemes === "string" && Array.isArray(frames) && frames.every(Number.isFinite)) {
        headers["x-phonemes"] = encodeURIComponent(phonemes);
        headers["x-frames"] = frames.join(",");
      }
      return new Response(Buffer.from(audio, "base64"), { headers });
    }
    const input = await body();
    if (input.answers !== undefined) {
      const a = answers(input.answers);
      if (typeof a === "string") return error(400, a);
      return reply(await this.ask(bridge, { type: "say", key, answers: a }));
    }
    const text = input.text ?? "";
    if (typeof text !== "string" || text.length > 20_000) return error(400, "text must be a string, under 20000 characters");
    const keys = input.keys ?? [];
    if (!Array.isArray(keys) || keys.length > 16 || keys.some((k) => !KEYS.includes(k))) return error(400, `keys must be a list of ${KEYS.join(", ")}`);
    if (!text && !keys.length) return error(400, "say something: text, keys or both");
    return reply(await this.ask(bridge, { type: "say", key, text, keys }));
  }

  // The stream's answer is what the bridge sends down it; the request's
  // body, what's typed into a terminal and its size.
  private stream(req: Request, bridge: string, key: string, terminal: boolean): Response {
    let s: ReturnType<Hub["attach"]>;
    let done = () => {};
    const res = ndjson((send, end) => {
      s = this.attach(bridge, key, terminal, {
        out: (data) => send({ type: "out", data }),
        end: (why) => (send({ type: "end", why }), end()),
      });
      if (!s) {
        send({ type: "end", why: `bridge ${bridge} isn't connected` });
        end();
      }
      done = () => s?.close();
      return () => done();
    });
    if (s! && req.body)
      void lines(req.body, (m) => {
        if (m?.type === "in" && typeof m.data === "string") s!.input(m.data);
        else if (m?.type === "size") s!.size(m.rows, m.cols, m.focus === true);
      }).catch(() => {});
    return res;
  }
}

// A stream of JSON lines; follow is given the way to send one and to end,
// and returns what to do when the reader goes.
export function ndjson(follow: (send: (m: object) => void, end: () => void) => () => void): Response {
  let stop = () => {};
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      let ended = false;
      const send = (m: object) => {
        if (ended) return;
        try {
          c.enqueue(enc.encode(JSON.stringify(m) + "\n"));
        } catch {
          stop();
        }
      };
      const end = () => {
        if (ended) return;
        ended = true;
        try {
          c.close();
        } catch {}
      };
      stop = follow(send, end);
    },
    cancel: () => stop(),
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}

// Each JSON line of a body, as it comes; a line that isn't JSON is skipped.
// signal: when to stop reading, the body cancelled.
export async function lines(body: ReadableStream<Uint8Array>, fn: (m: any) => void, signal?: AbortSignal) {
  let buf = "";
  const dec = new TextDecoder();
  const rd = body.getReader();
  const stop = () => void rd.cancel().catch(() => {});
  if (signal?.aborted) return stop();
  signal?.addEventListener("abort", stop, { once: true });
  for (;;) {
    const { done, value: chunk } = await rd.read();
    if (done) break;
    buf += dec.decode(chunk, { stream: true });
    for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      try {
        fn(JSON.parse(line));
      } catch {}
    }
  }
}
