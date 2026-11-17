import { afterAll, beforeAll, describe, expect } from "bun:test";
import { type Channel, ChannelError, FRAME, type Handler, type Identity, WINDOW, initiate, pipe, respond } from "../channel";
import { certify, checkCert, newDevice } from "../device";
import { accountKeys, newRoot } from "../keys";
import { utf8 } from "../wire";
import { type Gen, fuzz } from "../../testing/fuzz";
import { Sched } from "../../testing/sched";

// Channels under the scheduler (lib/testing/sched.ts): every frame, body
// chunk, abort and close is a task it orders by the seed, so each run is
// one interleaving of them, and a failure's seed runs it again.

const keys = accountKeys(newRoot());
const device = (name: string): Identity => {
  const d = newDevice();
  return { device: d, cert: certify(keys, d, name), trust: (c) => checkCert(keys.id, c, []) };
};
const I = device("laptop");
const R = device("node");

// Whatever got away: a rejection nobody handled is a bug of its own.
const loose: unknown[] = [];
const onLoose = (e: unknown) => void loose.push(e);
beforeAll(() => void process.on("unhandledRejection", onLoose));
afterAll(() => void process.off("unhandledRejection", onLoose));

type Dir = "i→r" | "r→i";
type Middle = (m: Uint8Array, dir: Dir, n: number) => Uint8Array[];

// Two pipes whose messages are the scheduler's to deliver, each way in order.
function wire(s: Sched, middle: Middle = (m) => [m]) {
  const lane = { "i→r": s.lane(), "r→i": s.lane() };
  const n = { "i→r": 0, "r→i": 0 };
  let a: ReturnType<typeof pipe>, b: ReturnType<typeof pipe>;
  const to = (dir: Dir, other: () => ReturnType<typeof pipe>) => ({
    send: (m: Uint8Array) => {
      for (const x of middle(m, dir, n[dir]++)) lane[dir](() => other().deliver(x));
    },
    end: (reason: string) => lane[dir](() => other().end(reason)),
  });
  const ab = to("i→r", () => b),
    ba = to("r→i", () => a);
  a = pipe(ab.send, ab.end);
  b = pipe(ba.send, ba.end);
  return { i: a.link, r: b.link, relayDrops: (reason: string) => (a.end(reason), b.end(reason)) };
}

const isChannelFailure = (e: unknown) => e instanceof ChannelError || (e as Error)?.name === "AbortError";

// Bytes anyone can make again from n and a salt.
const pattern = (n: number, salt: number) => Uint8Array.from({ length: n }, (_, k) => (k * 31 + salt) & 0xff);

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

// What each side serves: an echo that streams the body back as it comes, a
// fixed answer that never reads the body, a reader of the whole body, a
// handler that throws, and an answer with no body.
const serve =
  (s: Sched): Handler =>
  async (req) => {
    const [, kind, arg] = new URL(req.url).pathname.split("/");
    await s.yield();
    if (kind === "echo") return new Response(req.body);
    if (kind === "fixed") return new Response(pattern(Number(arg), 7));
    if (kind === "drain") return new Response(String((await req.arrayBuffer()).byteLength));
    if (kind === "fail") throw new Error("boom");
    return new Response(null, { status: 204 });
  };

// A request body in chunks the scheduler hands over, now and then failing.
function body(s: Sched, g: Gen, data: Uint8Array, fails: boolean) {
  const lane = s.lane();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let at = 0; at < data.length; ) {
        const n = Math.min(data.length - at, g.int(1, 3 * FRAME));
        const chunk = data.slice(at, (at += n));
        lane(() => c.enqueue(chunk));
      }
      lane(() => (fails ? c.error(new Error("the body broke")) : c.close()));
    },
  });
}

async function readAll(s: Sched, res: Response, cancelAfter: number | undefined): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const rd = res.body.getReader();
  const parts: Uint8Array[] = [];
  for (let k = 0; ; k++) {
    await s.yield();
    if (k === cancelAfter) {
      await rd.cancel();
      throw new ChannelError("cancelled here");
    }
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value);
  }
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

type Plan = { from: "i" | "r"; kind: string; size: number; stream: boolean; fails: boolean; abortAt?: number; cancelAfter?: number };

function plan(g: Gen): Plan {
  const kind = g.pick(["echo", "echo", "fixed", "drain", "fail", "empty"]);
  // Now and then past the window, so a sender waits on the reader.
  const size = g.bool(0.15) ? g.int(WINDOW, 2 * WINDOW + FRAME) : g.size(3 * FRAME);
  const stream = g.bool(0.6);
  return {
    from: g.bool(0.8) ? "i" : "r",
    kind,
    size,
    stream,
    fails: stream && g.bool(0.05),
    abortAt: g.bool(0.08) ? g.int(0, 40) : undefined,
    cancelAfter: g.bool(0.08) ? g.int(0, 4) : undefined,
  };
}

const clean = (p: Plan) => !p.fails && p.abortAt === undefined && p.cancelAfter === undefined;

async function run(s: Sched, ch: Channel, p: Plan, k: number, verify = true): Promise<"ok"> {
  const data = pattern(p.size, k);
  const ac = new AbortController();
  if (p.abortAt !== undefined) {
    let n = p.abortAt;
    const later = () => (n-- ? s.soon(later) : ac.abort());
    s.soon(later);
  }
  const res = await ch.fetch(`/${p.kind}/${p.size}`, { method: "POST", body: p.stream ? body(s, s.g, data, p.fails) : data, signal: ac.signal });
  const got = await readAll(s, res, p.cancelAfter);
  // An answer forged by the other side is only expected to settle.
  if (!verify) return "ok";
  if (p.kind === "echo") expect(same(got, data), "echoed").toBe(true);
  if (p.kind === "fixed") expect(same(got, pattern(p.size, 7)), "fixed").toBe(true);
  if (p.kind === "drain") expect(new TextDecoder().decode(got)).toBe(String(p.size));
  if (p.kind === "fail") expect(res.status).toBe(500);
  if (p.kind === "empty") expect([res.status, got.length]).toEqual([204, 0]);
  return "ok";
}

const streams = (ch: Channel) => (ch as unknown as { streams: Map<number, unknown> }).streams.size;

describe("channels, fuzzed", () => {
  fuzz(
    "carry every request in any interleaving, and leave nothing behind",
    async (g) => {
      const s = new Sched(g);
      const w = wire(s);
      const shake = s.track("handshake", Promise.all([initiate(w.i, I, R.device.id, { serve: serve(s), timeout: 60_000 }), respond(w.r, R, { serve: serve(s), timeout: 60_000 })]));
      await s.run();
      const [i, r] = await shake;

      const plans = Array.from({ length: g.int(1, 8) }, () => plan(g));
      // Now and then the channel goes in the middle of it.
      const fault = g.bool(0.15) ? g.pick(["i", "r", "relay"] as const) : undefined;
      if (fault) {
        let n = g.int(0, 60);
        const later = () => (n-- ? s.soon(later) : fault === "relay" ? w.relayDrops("the relay went") : (fault === "i" ? i : r).close("gone"));
        s.soon(later);
      }
      const outcomes = plans.map((p, k) =>
        s.track(
          `request ${k} ${JSON.stringify(p)}`,
          run(s, p.from === "i" ? i : r, p, k).catch((e) => e),
        ),
      );
      await s.run();
      expect(s.pending(), "hung").toEqual([]);
      const got = await Promise.all(outcomes);
      got.forEach((o, k) => {
        if (o === "ok") return;
        // A request that had everything go right must have gone right.
        if (!fault && clean(plans[k])) throw o;
        if (!isChannelFailure(o)) throw o;
      });
      if (!fault) {
        expect(i.open && r.open).toBe(true);
        expect([streams(i), streams(r)], `streams left open: ${JSON.stringify(plans)}`).toEqual([0, 0]);
      }
      expect(loose).toEqual([]);
      i.close();
    },
    { runs: 150 },
  );

  fuzz(
    "survive whatever an account's device sends it, and still settle every request",
    async (g) => {
      const s = new Sched(g);
      const w = wire(s);
      const shake = Promise.all([initiate(w.i, I, R.device.id, { serve: serve(s), timeout: 60_000 }), respond(w.r, R, { serve: serve(s), timeout: 60_000 })]);
      await s.run();
      const [i, r] = await shake;
      // R's side sends frames of its own making: types known and not, on
      // streams that are I's, R's or nobody's, with any payload.
      const send = (r as unknown as { frame(t: number, id: number, p: Uint8Array): void }).frame.bind(r);
      for (let n = g.int(1, 20); n > 0; n--) {
        const type = g.int(0, 7);
        const id = g.pick([0, 1, 2, 3, 4, 5, 0xffffffff, g.int(0, 2 ** 32 - 1)]);
        const payload =
          type === 2 ? utf8(JSON.stringify(g.bool(0.5) ? { status: g.pick([200, 99, 600, 1.5, -1, "200"]), headers: g.json(2) } : g.json(3)))
          : type === 1 ? utf8(JSON.stringify(g.bool(0.5) ? { method: g.pick(["GET", "POST", "BREW", "", "G\nET"]), path: g.pick(["/", "/x", "x", "//a", "/%zz"]), headers: g.json(2) } : g.json(3)))
          : type === 6 ? g.pick([new Uint8Array([0xff, 0xff, 0xff, 0xff]), new Uint8Array(4), g.bytes(6)])
          : g.bytes(32);
        let wait = g.int(0, 20);
        const later = () => (wait-- ? s.soon(later) : send(type, id, payload));
        s.soon(later);
      }
      const asks = Array.from({ length: g.int(1, 4) }, (_, k) => s.track(`request ${k}`, run(s, i, { from: "i", kind: "drain", size: g.size(FRAME), stream: g.bool(), fails: false }, k, false).catch((e) => e)));
      await s.run();
      expect(s.pending(), "hung").toEqual([]);
      for (const o of await Promise.all(asks)) if (o !== "ok" && !isChannelFailure(o)) throw o;
      expect(loose).toEqual([]);
      i.close();
    },
    { runs: 300 },
  );

  fuzz(
    "refuse a handshake changed on the way, and say so with a ChannelError",
    async (g) => {
      const s = new Sched(g);
      // One of the four handshake messages (I's key, R's hello, I's hello,
      // R's READY), changed, repeated, preceded by another, or dropped.
      const at = g.int(0, 3);
      const how = g.pick(["mutate", "repeat", "inject", "drop"] as const);
      let k = 0;
      const middle: Middle = (m) => {
        if (k++ !== at) return [m];
        if (how === "mutate") return [g.mutate(m)];
        if (how === "repeat") return [m, m];
        if (how === "inject") return [g.bytes(g.pick([32, 80, 200])), m];
        return [];
      };
      // Messages alternate sides, so the count across both is the handshake's.
      const w = wire(s, middle);
      const sides = [
        s.track("initiate", initiate(w.i, I, R.device.id, { timeout: 30 })),
        s.track("respond", respond(w.r, R, { timeout: 30 })),
      ];
      await s.run();
      const hung = s.pending();
      const [ri, rr] = await Promise.allSettled(sides);
      for (const x of [ri, rr]) if (x.status === "rejected" && !(x.reason instanceof ChannelError)) throw x.reason;
      if (how !== "drop") expect(hung, "hung").toEqual([]);
      // Both open is the one outcome a change mustn't have, unless the
      // channel then ends: a repeated READY is the next frame, which doesn't open.
      if (ri.status === "fulfilled" && rr.status === "fulfilled") {
        await s.run();
        expect(ri.value.open && rr.value.open).toBe(false);
      }
      expect(loose).toEqual([]);
    },
    { runs: 300 },
  );
});
