// Serving Claude Code sessions to the phone and the fleet view, through the
// Worker (cloud/src/user.ts): following the user's live socket as a bridge
// (?bridge=), saying what sessions there are whenever that changes, and
// answering what's asked of one: its screen, something typed into it, and
// its conversation as it goes, read from its log (transcript.ts). The
// bridge serves its pages' sessions (remote.ts), fleetd its VMs'
// (fleet/fleetd/sessions.ts).

import { hostname } from "node:os";
import { CLOUD, token } from "./cloud";
import { Follower, type Item } from "./transcript";

// One session, as the Worker hears of it, and where its log is (which stays
// here). key: what it's asked for by.
export type Hosted = {
  key: string;
  name: string;
  state: string;
  project?: string;
  since?: number;
  detail?: string;
  typed?: number;
  host?: string;
  vm?: string;
  role?: string;
  card?: string;
  context?: number;
  spawn?: string;
  transcript?: string;
};

export type Answer = Record<string, unknown>;

export type Source = {
  list(): Hosted[];
  // Called whenever the list may have changed.
  watch(fn: () => void): void;
  say(key: string, text: string, keys: string[]): Promise<Answer>;
  screen?(key: string): Promise<Answer>;
};

// How much of the conversation a stream starts with.
const FIRST = 200;
// The bridge's page, when it's served from anywhere (server.ts's ORIGIN):
// the portal opens boards there (cloud/src/portal.ts).
const PAGE = process.env.CORKBOARD_ORIGIN;

type Stream = { key: string; follower?: Follower; timer?: ReturnType<typeof setInterval> };

export function serve(id: string, environment: string, source: Source) {
  let ws: WebSocket | undefined;
  const streams = new Map<string, Stream>();
  const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  // Where its log is stays here: only whether it can be followed goes.
  const report = () =>
    send({ type: "sessions", environment, sessions: source.list().map(({ transcript, ...s }) => ({ ...s, attach: !!transcript })) });
  source.watch(report);

  const answer = async (q: any) => {
    if (typeof q.key !== "string") return send({ type: "answer", ask: q.ask, error: "which session?" });
    const a =
      q.type === "screen"
        ? source.screen
          ? await source.screen(q.key)
          : { error: "that session has no screen here" }
        : await source.say(q.key, typeof q.text === "string" ? q.text : "", Array.isArray(q.keys) ? q.keys : []);
    send({ ...a, type: "answer", ask: q.ask });
  };

  // Streams ------------------------------------------------------------------------
  //
  // A stream is someone following one session's conversation: the last of
  // it to start with, then each item as its log grows. A new log (a /clear)
  // starts them over.

  const end = (stream: string, why?: string) => {
    const s = streams.get(stream);
    if (s) {
      streams.delete(stream);
      clearInterval(s.timer);
    }
    send({ type: "end", stream, ...(why && { why }) });
  };

  // In batches, each well under a socket message's limit.
  const out = (stream: string, items: Item[], reset = false) => {
    for (let i = 0; i < items.length || (reset && i === 0); i += 40) {
      send({ type: "out", stream, data: JSON.stringify({ items: items.slice(i, i + 40), ...(reset && i === 0 && { reset: true }) }) });
    }
  };

  const attach = (stream: string, key: string) => {
    const s: Stream = { key };
    streams.set(stream, s);
    const look = () => {
      const session = source.list().find((x) => x.key === s.key);
      if (!session) return end(stream, "that session has ended");
      if (!session.transcript) return end(stream, "that session has no conversation here");
      if (s.follower?.path !== session.transcript) {
        s.follower = new Follower(session.transcript);
        out(stream, s.follower.read().slice(-FIRST), true);
      } else out(stream, s.follower.read());
    };
    look();
    if (streams.get(stream) === s) s.timer = setInterval(look, 500);
  };

  // Following ------------------------------------------------------------------------

  let retry = 1000;
  const follow = async () => {
    try {
      const url = `${CLOUD.replace(/^http/, "ws")}/api/live?bridge=${encodeURIComponent(id)}&machine=${encodeURIComponent(hostname())}${PAGE ? `&url=${encodeURIComponent(PAGE)}` : ""}`;
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${await token()}` } } as any);
      const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
      ws.onopen = () => {
        retry = 1000;
        report();
      };
      ws.onmessage = (e) => {
        let m: any;
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if ((m.type === "screen" || m.type === "say") && typeof m.ask === "number") answer(m);
        else if (m.type === "attach" && typeof m.stream === "string" && typeof m.key === "string") attach(m.stream, m.key);
        else if (m.type === "detach" && typeof m.stream === "string") end(m.stream);
      };
      ws.onclose = () => {
        clearInterval(ping);
        // Its streams went with it.
        for (const stream of [...streams.keys()]) end(stream);
        setTimeout(follow, (retry = Math.min(retry * 2, 60_000)));
      };
    } catch {
      // Not signed in, or no network: try again later.
      setTimeout(follow, (retry = Math.min(retry * 2, 60_000)));
    }
  };
  follow();
}

// A bridge's id: the same each run, so the phone keeps it across a restart.
export const bridgeId = (name: string) => name.replace(/[^\w-]/g, "-").slice(0, 64);
