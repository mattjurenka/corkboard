// Serving Claude Code sessions to the phone and the fleet view, through the
// Worker (its user.ts): following the user's live socket as a bridge
// (?bridge=), saying what sessions there are whenever that changes, and
// answering what's asked of one: its screen, something typed into it, its
// face's voice saying a sentence (the phone's avatar), and
// its conversation as it goes, read from its log (transcript.ts), or its
// terminal itself, mirrored both ways where the source has one. The
// bridge serves its pages' sessions (remote.ts), fleetd its VMs'
// (fleet/fleetd/sessions.ts). The same, said to its machine's hub
// (hub.ts), is served sealed on the relay's channels instead
// (.agent/plans/ciphertext-relay.md, step 3).

import { hostname } from "node:os";
import { CLOUD, token } from "./cloud";
import { Follower, type Item } from "./transcript";
import type { Peers } from "./peers";

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
  // Its face on the phone: its persona, and her skin.
  persona?: string;
  skin?: string;
};

export type Answer = Record<string, unknown>;

export type Source = {
  list(): Hosted[];
  // Called whenever the list may have changed.
  watch(fn: () => void): void;
  say(key: string, text: string, keys: string[]): Promise<Answer>;
  screen?(key: string): Promise<Answer>;
  // A sentence said in its face's voice: { rate, audio } (16-bit samples, base64).
  speech?(sentence: unknown): Promise<Answer>;
  // Its terminal, mirrored: given where its bytes go, what to do with a
  // stream's opening, keys (base64), size and closing.
  terminals?(to: TerminalOut): Terminals;
  // Every other bridge's sessions, as the Worker has them, whenever that
  // changes. They stay as they were while it can't be reached, so a blip
  // doesn't look like each of them ending.
  peers?(bridges: Peer[]): void;
  // Its machine's hub (hub.ts), joined beside the Worker's socket.
  hub?: HubJoin;
  // The account's hubs, watched on sealed channels (peers.ts): their
  // bridges are told to peers beside the Worker's, and over them.
  sealed?: Peers;
};

// Another bridge, as the Worker says of it (its user.ts Bridge).
export type Peer = { id: string; machine: string; sessions: (Hosted & { spawn?: string | null; attach?: boolean; terminal?: boolean })[] };

export type TerminalOut = { out(stream: string, data: string): void; end(stream: string, why: string): void };
export type Terminals = {
  open(stream: string, key: string): void;
  input(stream: string, data: string): void;
  size(stream: string, rows: number, cols: number, focus: boolean): void;
  close(stream: string): void;
};

// How much of the conversation a stream starts with.
const FIRST = 200;
// The bridge's page, when it's served from anywhere (server.ts's ORIGIN):
// the portal opens boards there (the hosted Worker's portal.ts).
const PAGE = process.env.CORKBOARD_ORIGIN;

// A link the bridge speaks the protocol on: the Worker's socket, or its
// machine's hub (hub.ts). send: what it says down it.
export type Link = { receive(m: any): void; drop(): void };
// How a bridge joins its machine's hub, and keeps joined: given who it is
// and connect, called each time a link opens, with how to send down it.
export type HubJoin = (hello: { id: string; machine: string; url?: string | null; environment: string }, connect: (send: (m: object) => void) => Link) => void;

type Stream = { key: string; send(m: object): void; follower?: Follower; timer?: ReturnType<typeof setInterval> };

// The protocol's bridge end, whatever it's linked to: each link hears the
// list, is asked and is sent its own streams.
function core(environment: string, source: Source) {
  const links = new Set<(m: object) => void>();
  const streams = new Map<string, Stream>();
  const mirrored = new Map<string, (m: object) => void>();

  // Where its log is stays here: only whether it can be followed goes. With
  // no screen to show, a session is followed before it has a log (fleetd's,
  // before its first message), which the stream waits for.
  const listed = () => ({
    type: "sessions",
    environment,
    sessions: source.list().map(({ transcript, ...s }) => ({ ...s, attach: !!transcript || !source.screen, terminal: !!source.terminals })),
  });
  source.watch(() => {
    if (!links.size) return;
    const m = listed();
    for (const send of links) send(m);
  });

  const answer = async (send: (m: object) => void, q: any) => {
    if (typeof q.key !== "string") return send({ type: "answer", ask: q.ask, error: "which session?" });
    const a =
      q.type === "screen"
        ? source.screen
          ? await source.screen(q.key)
          : { error: "that session has no screen here" }
        : q.type === "speech"
          ? source.speech
            ? await source.speech(q.sentence)
            : { error: "no voice here" }
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
    const send = s?.send ?? mirrored.get(stream);
    if (s) {
      streams.delete(stream);
      clearInterval(s.timer);
    }
    if (mirrored.delete(stream)) terminals?.close(stream);
    send?.({ type: "end", stream, ...(why && { why }) });
  };

  // A terminal's streams: its bytes as they come, base64 in "out".
  const terminals = source.terminals?.({
    out: (stream, data) => mirrored.get(stream)?.({ type: "out", stream, data }),
    end: (stream, why) => mirrored.has(stream) && end(stream, why),
  });
  const mirror = (send: (m: object) => void, stream: string, key: string) => {
    if (!terminals) return send({ type: "end", stream, why: "that session has no terminal here" });
    mirrored.set(stream, send);
    terminals.open(stream, key);
  };

  // In batches, each well under a socket message's limit.
  const out = (s: Stream, stream: string, items: Item[], reset = false) => {
    for (let i = 0; i < items.length || (reset && i === 0); i += 40) {
      s.send({ type: "out", stream, data: JSON.stringify({ items: items.slice(i, i + 40), ...(reset && i === 0 && { reset: true }) }) });
    }
  };

  const attach = (send: (m: object) => void, stream: string, key: string) => {
    const s: Stream = { key, send };
    streams.set(stream, s);
    const look = () => {
      const session = source.list().find((x) => x.key === s.key);
      if (!session) return end(stream, "that session has ended");
      if (!session.transcript) return source.screen ? end(stream, "that session has no conversation here") : undefined;
      if (s.follower?.path !== session.transcript) {
        s.follower = new Follower(session.transcript);
        out(s, stream, s.follower.read().slice(-FIRST), true);
      } else out(s, stream, s.follower.read());
    };
    look();
    if (streams.get(stream) === s) s.timer = setInterval(look, 500);
  };

  // A link opening: it's told the list at once. Its streams are its own,
  // and go with it.
  return (send: (m: object) => void): Link => {
    links.add(send);
    send(listed());
    const mine = (stream: unknown) => typeof stream === "string" && (streams.get(stream)?.send ?? mirrored.get(stream)) === send;
    return {
      receive(m: any) {
        if ((m.type === "screen" || m.type === "say" || m.type === "speech") && typeof m.ask === "number") answer(send, m);
        else if (m.type === "attach" && typeof m.stream === "string" && typeof m.key === "string" && !streams.has(m.stream) && !mirrored.has(m.stream))
          (m.terminal ? mirror : attach)(send, m.stream, m.key);
        else if (m.type === "detach" && mine(m.stream)) end(m.stream);
        else if (m.type === "in" && mine(m.stream) && mirrored.has(m.stream) && typeof m.data === "string") terminals?.input(m.stream, m.data);
        else if (m.type === "size" && mine(m.stream) && mirrored.has(m.stream)) terminals?.size(m.stream, m.rows, m.cols, m.focus === true);
      },
      drop() {
        links.delete(send);
        for (const stream of [...streams.keys(), ...mirrored.keys()]) if (mine(stream)) end(stream);
      },
    };
  };
}

export function serve(id: string, environment: string, source: Source) {
  const connect = core(environment, source);
  source.hub?.({ id, machine: hostname(), url: PAGE ?? null, environment }, connect);

  // Peers ------------------------------------------------------------------------
  //
  // The list once the socket opens, then each bridge as it changes, which
  // the Worker tells every socket of the user's, this one too.

  const peers = new Map<string, Peer>();
  const told = () => {
    const sealed = (source.sealed?.list(id) ?? []) as unknown as Peer[];
    const ids = new Set(sealed.map((b) => b.id));
    source.peers?.([...sealed, ...[...peers.values()].filter((b) => !ids.has(b.id))]);
  };
  if (source.peers) source.sealed?.on(told);
  const peer = (b: any) => {
    if (typeof b?.id !== "string" || b.id === id) return;
    if (b.gone || !Array.isArray(b.sessions)) peers.delete(b.id);
    else peers.set(b.id, b);
  };
  const lookUp = async () => {
    try {
      const res = await fetch(`${CLOUD}/api/sessions`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (!res.ok) return;
      peers.clear();
      for (const b of (await res.json()) as unknown[]) peer(b);
      told();
    } catch {}
  };

  // Following ------------------------------------------------------------------------

  let retry = 1000;
  const follow = async () => {
    try {
      const url = `${CLOUD.replace(/^http/, "ws")}/api/live?bridge=${encodeURIComponent(id)}&machine=${encodeURIComponent(hostname())}${PAGE ? `&url=${encodeURIComponent(PAGE)}` : ""}`;
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${await token()}` } } as any);
      const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
      let link: Link | undefined;
      ws.onopen = () => {
        retry = 1000;
        link = connect((m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)));
        if (source.peers) lookUp();
      };
      ws.onmessage = (e) => {
        let m: any;
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.type === "bridge" && source.peers) {
          peer(m.bridge);
          told();
        } else link?.receive(m);
      };
      ws.onclose = () => {
        clearInterval(ping);
        // Its streams went with it.
        link?.drop();
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
