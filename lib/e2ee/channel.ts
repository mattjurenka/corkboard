// A sealed channel between two of an account's devices, through the relay
// (relay/src/nodes.ts pairs the two ends and passes on frames it has no key
// to). See .agent/plans/ciphertext-relay.md. Byte for byte, so the Android
// app can speak it with libsodium (X25519, HKDF-SHA256, Ed25519,
// XChaCha20-Poly1305):
//
// The handshake, SIGMA-I keyed like Noise's XX: I opens, R answers.
//
//   m1  I → R  ie                       I's ephemeral X25519 key
//   m2  R → I  re || seal(kr, hello R)
//   m3  I → R  seal(ki, hello I)
//
//   ee = X25519(ie, re), es = X25519(ie, R's box key), se = X25519(I's box key, re)
//   h1 = SHA-256(PROLOGUE || ie || re)   kr = HKDF(ee, salt h1, "r")
//   h2 = SHA-256(h1 || m2)               ki = HKDF(ee || es, salt h2, "i")
//   h3 = SHA-256(h2 || m3)               HKDF(ee || es || se, salt h3, "transport", 64) = I→R key || R→I key
//
//   HKDF's info is "corkboard-e2ee/v1 channel <label>"; seal is XChaCha20-Poly1305 with a zero nonce.
//   hello = JSON { cert, sig }: the device's cert, and its device key's signature of
//   signed("channel", { role: "r" | "i", ie, re, h }), h "" for R and b64url(h2) for I.
//
// Each side checks the other's cert chains to the account and isn't revoked
// (Identity.trust), and I that R is the device it asked for. A relay that
// swaps a key can't sign for it, and can't open the hellos to learn whose
// they are.
//
// R's first frame is READY, once it has checked I's hello; I's channel is
// open only when it comes, so a refusal is never taken for an open channel.
//
// Then frames: XChaCha20-Poly1305 under the direction's key, the nonce 16
// zero bytes and a u64 big-endian count from 0. The count isn't sent, so a
// frame dropped, replayed or reordered doesn't open, and that ends the
// channel. Inside each one:
//
//   type (1) || stream (u32 BE) || payload
//   READY 0   R's first, stream 0, no payload
//   OPEN 1    JSON { method, path, headers }: I's streams are odd, R's even
//   HEAD 2    JSON { status, headers }: the answer
//   DATA 3    body bytes, at most FRAME, within what the other side allows
//   END 4     no more body from this side
//   RESET 5   a reason: the stream's over, both ways
//   WINDOW 6  u32 BE: how many more body bytes this side will take (WINDOW to start)
//
// A stream is an HTTP request and its answer, both bodies streamed, so it
// carries what a WebSocket or SSE does too: the opener's body stays open
// while the answer's streams back.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type Device, verify } from "./device";
import { boxPair, random } from "./keys";
import { type DeviceCert, type Signed, VERSION, b64url, concat, fromB64url, fromUtf8, signed, utf8 } from "./wire";

export class ChannelError extends Error {}

// What carries a channel's frames: a socket to the relay (wsLink), or one
// channel's share of a node's socket (pipe). closed is the other end going.
export type Link = {
  send(b: Uint8Array): void;
  close(reason: string): void;
  on(message: (b: Uint8Array) => void, closed: (reason: string) => void): void;
};

// This device, and how it decides whether a cert is one of its account's:
// why not, or null.
export type Identity = {
  device: Device;
  cert: Signed<DeviceCert>;
  trust(cert: Signed<DeviceCert>): Promise<string | null> | string | null;
};

export type Handler = (req: Request, ch: Channel) => Promise<Response>;

export const FRAME = 64 * 1024;
export const WINDOW = 256 * 1024;
const MAX_STREAMS = 256;
const HANDSHAKE_MS = 30_000;
const NULL_BODY = new Set([204, 205, 304]);

const PROLOGUE = utf8(`${VERSION} channel`);
const ZERO = new Uint8Array(24);
const kdf = (ikm: Uint8Array, salt: Uint8Array, label: string, n = 32) => hkdf(sha256, ikm, salt, utf8(`${VERSION} channel ${label}`), n);
const helloBytes = (role: "i" | "r", ie: Uint8Array, re: Uint8Array, h: string) => signed("channel", { role, ie: b64url(ie), re: b64url(re), h });

type Hello = { cert: Signed<DeviceCert>; sig: string };

function dh(secret: Uint8Array, pub: Uint8Array) {
  try {
    return x25519.getSharedSecret(secret, pub);
  } catch {
    throw new ChannelError("a handshake key is no good");
  }
}

function openHello(k: Uint8Array, c: Uint8Array): Hello {
  try {
    const h = JSON.parse(fromUtf8(xchacha20poly1305(k, ZERO).decrypt(c))) as Hello;
    if (typeof h?.sig === "string" && h.cert?.body && typeof h.cert.body.device === "string" && typeof h.cert.body.box === "string") return h;
  } catch {}
  throw new ChannelError("the other side's hello didn't open");
}

async function check(me: Identity, h: Hello, bytes: Uint8Array) {
  const why = await me.trust(h.cert);
  if (why) throw new ChannelError(why);
  if (!verify(h.cert.body.device, bytes, h.sig)) throw new ChannelError("the other side's hello isn't signed by its device");
}

const hello = (me: Identity, bytes: Uint8Array): Hello => ({ cert: me.cert, sig: b64url(ed25519.sign(bytes, me.device.sign.secret)) });

// A link's messages, waited for one at a time through the handshake, then
// handed to the channel as they come.
function reader(link: Link) {
  const queue: Uint8Array[] = [];
  let waiting: { ok(b: Uint8Array): void; fail(e: Error): void } | undefined;
  let ended: string | undefined;
  let then: { message(b: Uint8Array): void; closed(reason: string): void } | undefined;
  link.on(
    (b) => {
      if (then) then.message(b);
      else if (waiting) waiting.ok(b);
      else queue.push(b);
    },
    (reason) => {
      ended = reason;
      waiting?.fail(new ChannelError(reason));
      then?.closed(reason);
    },
  );
  return {
    next: () =>
      new Promise<Uint8Array>((ok, fail) => {
        const b = queue.shift();
        if (b) return ok(b);
        if (ended !== undefined) return fail(new ChannelError(ended));
        waiting = { ok: (b) => ((waiting = undefined), ok(b)), fail };
      }),
    hand(message: (b: Uint8Array) => void, closed: (reason: string) => void) {
      then = { message, closed };
      for (const b of queue.splice(0)) message(b);
      if (ended !== undefined) closed(ended);
    },
  };
}

type Reader = ReturnType<typeof reader>;

async function handshake(link: Link, ms: number, run: () => Promise<Channel>): Promise<Channel> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new ChannelError("the handshake took too long")), ms)));
  try {
    return await Promise.race([run(), late]);
  } catch (e) {
    link.close(e instanceof ChannelError ? e.message : "the handshake failed");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type ChannelOptions = { serve?: Handler; timeout?: number };

// The opening side: to is the device it means to reach.
export function initiate(link: Link, me: Identity, to: string, o: ChannelOptions = {}): Promise<Channel> {
  const r = reader(link);
  return handshake(link, o.timeout ?? HANDSHAKE_MS, async () => {
    const e = boxPair(random(32));
    link.send(e.public);
    const m2 = await r.next();
    if (m2.length < 32 + 16) throw new ChannelError("the other side's hello is too short");
    const re = m2.slice(0, 32);
    const ee = dh(e.secret, re);
    const h1 = sha256(concat(PROLOGUE, e.public, re));
    const peer = openHello(kdf(ee, h1, "r"), m2.subarray(32));
    if (peer.cert.body.device !== to) throw new ChannelError("the other side isn't the device asked for");
    await check(me, peer, helloBytes("r", e.public, re, ""));
    const es = dh(e.secret, fromB64url(peer.cert.body.box));
    const h2 = sha256(concat(h1, m2));
    const m3 = xchacha20poly1305(kdf(concat(ee, es), h2, "i"), ZERO).encrypt(utf8(JSON.stringify(hello(me, helloBytes("i", e.public, re, b64url(h2))))));
    link.send(m3);
    const se = dh(me.device.box.secret, re);
    const keys = kdf(concat(ee, es, se), sha256(concat(h2, m3)), "transport", 64);
    e.secret.fill(0);
    const ready = await r.next();
    let first: Uint8Array | undefined;
    try {
      first = xchacha20poly1305(keys.slice(32), nonce(0)).decrypt(ready);
    } catch {}
    if (!first || first.length !== 5 || first.some((b) => b !== 0)) throw new ChannelError("the other side's first frame isn't READY");
    return new Channel(link, r, keys.slice(0, 32), keys.slice(32), peer.cert, true, o.serve, 1);
  });
}

// The answering side: whoever of the account opened it.
export function respond(link: Link, me: Identity, o: ChannelOptions = {}): Promise<Channel> {
  const r = reader(link);
  return handshake(link, o.timeout ?? HANDSHAKE_MS, async () => {
    const ie = await r.next();
    if (ie.length !== 32) throw new ChannelError("the other side's key is the wrong size");
    const e = boxPair(random(32));
    const ee = dh(e.secret, ie);
    const h1 = sha256(concat(PROLOGUE, ie, e.public));
    const m2 = concat(e.public, xchacha20poly1305(kdf(ee, h1, "r"), ZERO).encrypt(utf8(JSON.stringify(hello(me, helloBytes("r", ie, e.public, ""))))));
    link.send(m2);
    const es = dh(me.device.box.secret, ie);
    const h2 = sha256(concat(h1, m2));
    const m3 = await r.next();
    const peer = openHello(kdf(concat(ee, es), h2, "i"), m3);
    await check(me, peer, helloBytes("i", ie, e.public, b64url(h2)));
    const se = dh(e.secret, fromB64url(peer.cert.body.box));
    const keys = kdf(concat(ee, es, se), sha256(concat(h2, m3)), "transport", 64);
    e.secret.fill(0);
    const ch = new Channel(link, r, keys.slice(32), keys.slice(0, 32), peer.cert, false, o.serve);
    ch.ready();
    return ch;
  });
}

const T = { ready: 0, open: 1, head: 2, data: 3, end: 4, reset: 5, window: 6 } as const;

type Head = { status: number; headers: [string, string][] };

type Stream = {
  id: number;
  // What this side may still send, and what it still takes.
  credit: number;
  allowed: number;
  wake?: () => void;
  queue: Uint8Array[];
  waiting?: () => void;
  remoteEnd: boolean;
  localEnd: boolean;
  dead?: Error;
  // This side's body being sent, stopped as soon as the stream ends.
  stop?: () => void;
  head?: { ok(h: Head): void; fail(e: Error): void };
};

function nonce(n: number): Uint8Array {
  const b = new Uint8Array(24);
  const v = new DataView(b.buffer);
  v.setUint32(16, Math.floor(n / 2 ** 32));
  v.setUint32(20, n >>> 0);
  return b;
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

export class Channel {
  private streams = new Map<number, Stream>();
  private nextId: number;
  private lastPeer = 0;
  private sent = 0;
  private ended?: string;
  private end!: (reason: string) => void;
  // Why it ended: closed here, the other side or the relay gone, or a frame that didn't open.
  readonly closed = new Promise<string>((done) => (this.end = done));

  constructor(
    private link: Link,
    r: Reader,
    private tx: Uint8Array,
    private rx: Uint8Array,
    readonly peer: Signed<DeviceCert>,
    private initiator: boolean,
    private handler?: Handler,
    // Frames already had: I's READY.
    private got = 0,
  ) {
    this.nextId = initiator ? 1 : 2;
    r.hand(
      (b) => this.receive(b),
      (reason) => this.finish(reason),
    );
  }

  // R's: the handshake's done here.
  ready() {
    this.frame(T.ready, 0);
  }

  get open() {
    return this.ended === undefined;
  }

  close(reason = "closed") {
    if (this.ended !== undefined) return;
    this.link.close(reason);
    this.finish(reason);
  }

  private finish(reason: string) {
    if (this.ended !== undefined) return;
    this.ended = reason;
    for (const s of [...this.streams.values()]) this.kill(s, new ChannelError(reason));
    this.end(reason);
  }

  // A request to the other side, answered as the fetch API would.
  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    if (this.ended !== undefined) throw new ChannelError(this.ended);
    const req = new Request(new URL(input, "http://channel.invalid"), { ...init, ...(init.body != null && { duplex: "half" }) } as RequestInit);
    const url = new URL(req.url);
    const s = this.stream(this.nextId);
    this.nextId += 2;
    const head = new Promise<Head>((ok, fail) => (s.head = { ok, fail }));
    this.frame(T.open, s.id, utf8(JSON.stringify({ method: req.method, path: url.pathname + url.search, headers: [...req.headers] })));
    void this.pump(s, req.body);
    init.signal?.addEventListener("abort", () => this.reset(s, "aborted"));
    const h = await head;
    return new Response(req.method === "HEAD" || NULL_BODY.has(h.status) ? null : this.body(s), { status: h.status, headers: h.headers });
  }

  private stream(id: number): Stream {
    const s: Stream = { id, credit: WINDOW, allowed: WINDOW, queue: [], remoteEnd: false, localEnd: false };
    this.streams.set(id, s);
    return s;
  }

  private frame(type: number, id: number, payload: Uint8Array = new Uint8Array(0)) {
    if (this.ended !== undefined) return;
    const plain = new Uint8Array(5 + payload.length);
    plain[0] = type;
    new DataView(plain.buffer).setUint32(1, id);
    plain.set(payload, 5);
    this.link.send(xchacha20poly1305(this.tx, nonce(this.sent++)).encrypt(plain));
  }

  private receive(b: Uint8Array) {
    if (this.ended !== undefined) return;
    let plain: Uint8Array;
    try {
      plain = xchacha20poly1305(this.rx, nonce(this.got++)).decrypt(b);
    } catch {
      return this.close("a frame didn't open: dropped, replayed, reordered or changed");
    }
    if (plain.length < 5) return this.close("a frame is too short");
    const type = plain[0];
    const id = new DataView(plain.buffer, plain.byteOffset).getUint32(1);
    const payload = plain.subarray(5);
    if (type === T.open) {
      // The other side's ids, each new one higher.
      if (id % 2 !== (this.initiator ? 0 : 1) || id <= this.lastPeer) return this.close("a stream was opened out of turn");
      this.lastPeer = id;
      const s = this.stream(id);
      if (this.streams.size > MAX_STREAMS) return this.reset(s, "too many streams");
      return void this.answer(s, payload);
    }
    const s = this.streams.get(id);
    // A stream already over: what was in flight when it ended.
    if (!s) return;
    if (type === T.head) {
      const h = parse<Head>(payload);
      if (!s.head || !h || !Number.isInteger(h.status) || !Array.isArray(h.headers)) return this.reset(s, "a bad answer");
      s.head.ok(h);
      s.head = undefined;
    } else if (type === T.data) {
      if (s.remoteEnd || payload.length > s.allowed) return this.close("a stream sent more than it was allowed");
      s.allowed -= payload.length;
      s.queue.push(payload.slice());
      s.waiting?.();
    } else if (type === T.end) {
      s.remoteEnd = true;
      s.waiting?.();
      this.settle(s);
    } else if (type === T.reset) {
      this.kill(s, new ChannelError(fromUtf8(payload) || "reset"));
    } else if (type === T.window) {
      if (payload.length !== 4) return this.close("a bad window");
      s.credit += new DataView(payload.buffer, payload.byteOffset).getUint32(0);
      s.wake?.();
    } else return this.close("an unknown frame");
  }

  // A request from the other side, served by the handler.
  private async answer(s: Stream, head: Uint8Array) {
    const h = parse<{ method: string; path: string; headers: [string, string][] }>(head);
    if (!h || typeof h.method !== "string" || typeof h.path !== "string" || !h.path.startsWith("/") || !Array.isArray(h.headers)) return this.reset(s, "a bad request");
    if (!this.handler) return this.reset(s, "nothing is served on this channel");
    let res: Response;
    try {
      const hasBody = !/^(GET|HEAD)$/i.test(h.method);
      const req = new Request(`http://channel.invalid${h.path}`, { method: h.method, headers: h.headers, ...(hasBody && { body: this.body(s), duplex: "half" }) } as RequestInit);
      res = await this.handler(req, this);
    } catch (e) {
      res = Response.json({ error: (e as Error).message }, { status: 500 });
    }
    if (s.dead) return void res.body?.cancel().catch(() => {});
    this.frame(T.head, s.id, utf8(JSON.stringify({ status: res.status, headers: [...res.headers] } satisfies Head)));
    await this.pump(s, h.method.toUpperCase() === "HEAD" || NULL_BODY.has(res.status) ? null : res.body);
  }

  // The other side's body, read as it comes; what's read is let in again.
  private body(s: Stream): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
      {
        pull: async (c) => {
          while (!s.queue.length && !s.remoteEnd && !s.dead) await new Promise<void>((r) => (s.waiting = r));
          s.waiting = undefined;
          const b = s.queue.shift();
          if (b) {
            c.enqueue(b as Uint8Array<ArrayBuffer>);
            s.allowed += b.length;
            if (!s.dead) this.frame(T.window, s.id, u32(b.length));
          } else if (s.dead) c.error(s.dead);
          else c.close();
        },
        cancel: () => this.reset(s, "the reader stopped"),
      },
      { highWaterMark: 0 },
    );
  }

  // This side's body, sent as the other side lets it in.
  private async pump(s: Stream, body: ReadableStream<Uint8Array> | null) {
    if (body) {
      const rd = body.getReader();
      s.stop = () => void rd.cancel().catch(() => {});
      try {
        for (;;) {
          if (s.dead) return void rd.cancel().catch(() => {});
          const { done, value } = await rd.read();
          if (done) break;
          for (let at = 0; at < value.length; ) {
            while (s.credit <= 0 && !s.dead) await new Promise<void>((r) => (s.wake = r));
            s.wake = undefined;
            if (s.dead) return void rd.cancel().catch(() => {});
            const n = Math.min(value.length - at, FRAME, s.credit);
            s.credit -= n;
            this.frame(T.data, s.id, value.subarray(at, at + n));
            at += n;
          }
        }
      } catch {
        return this.reset(s, "the body failed");
      }
    }
    if (s.dead) return;
    s.localEnd = true;
    this.frame(T.end, s.id);
    this.settle(s);
  }

  private settle(s: Stream) {
    if (s.localEnd && s.remoteEnd && !s.head) this.streams.delete(s.id);
  }

  private reset(s: Stream, reason: string) {
    if (s.dead) return;
    this.frame(T.reset, s.id, utf8(reason));
    this.kill(s, new ChannelError(reason));
  }

  private kill(s: Stream, e: Error) {
    if (s.dead) return;
    s.dead = e;
    s.wake?.();
    s.waiting?.();
    s.stop?.();
    s.head?.fail(e);
    s.head = undefined;
    this.streams.delete(s.id);
  }
}

function parse<T>(b: Uint8Array): T | undefined {
  try {
    return JSON.parse(fromUtf8(b)) as T;
  } catch {
    return;
  }
}

// A link over a WebSocket of its own: the opener's socket to /e2ee/channel.
export function wsLink(ws: WebSocket): Link {
  ws.binaryType = "arraybuffer";
  return {
    send: (b) => ws.readyState === 1 && ws.send(b as Uint8Array<ArrayBuffer>),
    close: (reason) => ws.close(1000, reason.slice(0, 120)),
    on(message, closed) {
      ws.addEventListener("message", (e: MessageEvent) => typeof e.data !== "string" && message(new Uint8Array(e.data as ArrayBuffer)));
      ws.addEventListener("close", (e: CloseEvent) => closed(e.reason || `the relay closed it (${e.code})`));
    },
  };
}

// A link whose messages are delivered by hand: one channel among many on a
// node's socket, or the two ends of a test.
export function pipe(send: (b: Uint8Array) => void, close: (reason: string) => void) {
  let on: ((b: Uint8Array) => void) | undefined;
  let off: ((reason: string) => void) | undefined;
  // What came before anyone listened, and an end before then.
  const early: Uint8Array[] = [];
  let ended: string | undefined;
  let done = false;
  const link: Link = {
    send: (b) => done || send(b),
    close: (reason) => {
      if (done) return;
      done = true;
      close(reason);
    },
    on(m, c) {
      [on, off] = [m, c];
      for (const b of early.splice(0)) m(b);
      if (ended !== undefined) c(ended);
    },
  };
  return {
    link,
    deliver: (b: Uint8Array) => done || (on ? on(b) : early.push(b)),
    end(reason: string) {
      if (done) return;
      done = true;
      if (off) off(reason);
      else ended = reason;
    },
  };
}
