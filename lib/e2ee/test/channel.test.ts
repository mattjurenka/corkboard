import { describe, expect, it } from "bun:test";
import { ChannelError, FRAME, type Handler, type Identity, initiate, pipe, respond } from "../channel";
import { certify, checkCert, newDevice, revoke } from "../device";
import { accountKeys, newRoot } from "../keys";
import { type Revocation, type Signed, utf8 } from "../wire";

// Two of an account's devices, and between them a relay that sees every
// message and may change, hold back or repeat one (middle).
function account() {
  const keys = accountKeys(newRoot());
  const revoked: Signed<Revocation>[] = [];
  const device = (name: string): Identity => {
    const d = newDevice();
    return { device: d, cert: certify(keys, d, name), trust: (c) => checkCert(keys.id, c, revoked) };
  };
  return { keys, revoked, device };
}

type Middle = (m: Uint8Array, dir: "i→r" | "r→i", n: number) => Uint8Array[];

function wire(middle: Middle = (m) => [m]) {
  const n = { "i→r": 0, "r→i": 0 };
  let a: ReturnType<typeof pipe>, b: ReturnType<typeof pipe>;
  const pass = (to: () => ReturnType<typeof pipe>, dir: "i→r" | "r→i") => (m: Uint8Array) => queueMicrotask(() => middle(m, dir, n[dir]++).forEach((x) => to().deliver(x)));
  a = pipe(pass(() => b, "i→r"), (r) => b.end(r));
  b = pipe(pass(() => a, "r→i"), (r) => a.end(r));
  return { i: a.link, r: b.link };
}

async function pair(o: { serve?: Handler; serveI?: Handler; middle?: Middle; i?: Identity; r?: Identity } = {}) {
  const acct = account();
  const iId = o.i ?? acct.device("laptop");
  const rId = o.r ?? acct.device("node");
  const w = wire(o.middle);
  const [i, r] = await Promise.all([initiate(w.i, iId, rId.device.id, { serve: o.serveI, timeout: 2000 }), respond(w.r, rId, { serve: o.serve, timeout: 2000 })]);
  return { i, r, iId, rId };
}

const echo: Handler = async (req, ch) =>
  new Response(req.body, { status: 201, headers: { "x-path": new URL(req.url).pathname + new URL(req.url).search, "x-from": ch.peer.body.name, "x-method": req.method, "x-auth": req.headers.get("authorization") ?? "" } });

describe("channels", () => {
  it("carry requests and their answers between two of the account's devices, both ways", async () => {
    const { i, r } = await pair({ serve: echo, serveI: async () => new Response("from the laptop") });
    expect(i.peer.body.name).toBe("node");
    expect(r.peer.body.name).toBe("laptop");
    const res = await i.fetch("/mcp?tools=memory", { method: "POST", headers: { Authorization: "Bearer xyz" }, body: '{"a":1}' });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-path")).toBe("/mcp?tools=memory");
    expect(res.headers.get("x-from")).toBe("laptop");
    expect(res.headers.get("x-auth")).toBe("Bearer xyz");
    expect(await res.text()).toBe('{"a":1}');
    // A GET has no body; HEAD and 204 answers none.
    expect((await i.fetch("/x")).headers.get("x-method")).toBe("GET");
    expect(await (await r.fetch("/back")).text()).toBe("from the laptop");
    // Many at once.
    const many = await Promise.all(Array.from({ length: 20 }, (_, k) => i.fetch(`/n/${k}`, { method: "PUT", body: `body ${k}` }).then((x) => x.text())));
    expect(many).toEqual(Array.from({ length: 20 }, (_, k) => `body ${k}`));
  });

  it("stream bodies of any size within the window, and duplex ones like a socket", async () => {
    const { i } = await pair({ serve: echo });
    // 20 MB, past the tunnel's 17, in frames.
    const big = new Uint8Array(20 * 1024 * 1024);
    for (let k = 0; k < big.length; k += 4096) big[k] = k & 0xff;
    const back = new Uint8Array(await (await i.fetch("/big", { method: "POST", body: big })).arrayBuffer());
    expect(back.length).toBe(big.length);
    expect(Buffer.from(back).equals(Buffer.from(big))).toBe(true);

    // The answer starts before the request's body ends, and each line comes back as it's sent.
    let send!: ReadableStreamDefaultController<Uint8Array>;
    const up = new ReadableStream<Uint8Array>({ start: (c) => void (send = c) });
    const res = await i.fetch("/live", { method: "POST", body: up });
    const rd = res.body!.getReader();
    for (const line of ["one", "two", "three"]) {
      send.enqueue(utf8(line));
      expect(new TextDecoder().decode((await rd.read()).value)).toBe(line);
    }
    send.close();
    expect((await rd.read()).done).toBe(true);
  });

  it("hold a sender to what the reader has taken", async () => {
    let sent = 0;
    const { i } = await pair({
      serve: async () =>
        new Response(
          new ReadableStream({
            pull: (c) => {
              sent += FRAME;
              c.enqueue(new Uint8Array(FRAME));
            },
          }),
        ),
    });
    const res = await i.fetch("/endless");
    await new Promise((r) => setTimeout(r, 50));
    // Nothing read: no more than the window (and what the server's stream had ready).
    expect(sent).toBeLessThanOrEqual(256 * 1024 + 2 * FRAME);
    await res.body!.cancel();
  });

  it("refuse a device that's revoked, of another account, or not the one asked for", async () => {
    const a = account();
    const laptop = a.device("laptop");
    const node = a.device("node");
    a.revoked.push(revoke(a.keys, node.device.id));
    await expect(pair({ i: laptop, r: node })).rejects.toThrow(/revoked/);
    a.revoked.length = 0;

    const other = account().device("someone else's");
    await expect(pair({ i: laptop, r: other })).rejects.toThrow(/another account/);
    await expect(pair({ i: other, r: node })).rejects.toThrow();

    // Asked for one device, answered by another of the account's.
    const w = wire();
    const third = a.device("third");
    const got = Promise.all([initiate(w.i, laptop, node.device.id, { timeout: 2000 }), respond(w.r, third, { timeout: 2000 })]);
    await expect(got).rejects.toThrow(/isn't the device asked for/);
  });

  it("can't be sat in the middle of: a relay that swaps a key is caught", async () => {
    const a = account();
    // Swapping the opener's key: the answer is sealed to a key it doesn't have.
    const swap: Middle = (m, dir, n) => (dir === "i→r" && n === 0 ? [crypto.getRandomValues(new Uint8Array(32))] : [m]);
    await expect(pair({ middle: swap, i: a.device("laptop"), r: a.device("node") })).rejects.toBeInstanceOf(ChannelError);
    // Swapping the answerer's.
    const swap2: Middle = (m, dir, n) => (dir === "r→i" && n === 0 ? [Uint8Array.from([...crypto.getRandomValues(new Uint8Array(32)), ...m.subarray(32)])] : [m]);
    await expect(pair({ middle: swap2, i: a.device("laptop"), r: a.device("node") })).rejects.toThrow(/didn't open/);
  });

  it("end when a frame is replayed, dropped, reordered or changed", async () => {
    const cases: [string, (m: Uint8Array, held: Uint8Array[]) => Uint8Array[]][] = [
      ["replayed", (m) => [m, m]],
      ["dropped", () => []],
      ["reordered", (m, held) => (held.length ? [m, held.pop()!] : (held.push(m), []))],
      ["changed", (m) => [Uint8Array.from(m, (x, k) => (k === 3 ? x ^ 1 : x))]],
    ];
    for (const [what, f] of cases) {
      const held: Uint8Array[] = [];
      // After the handshake (two messages from I), I's first two frames.
      const middle: Middle = (m, dir, n) => (dir === "i→r" && n >= 2 && n < 4 ? f(m, held) : [m]);
      const { i, r } = await pair({ serve: echo, middle });
      const answers = [i.fetch("/a", { method: "POST", body: "x" }), i.fetch("/b")].map((p) => p.catch((e) => e));
      expect(await r.closed, what).toMatch(/didn't open/);
      expect(await i.closed).toMatch(/didn't open/);
      for (const a of await Promise.all(answers)) expect(a).toBeInstanceOf(ChannelError);
    }
  });

  it("end every stream when the link goes", async () => {
    const { i, r } = await pair({ serve: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) });
    const res = await i.fetch("/forever");
    const reading = res.body!.getReader().read();
    r.close("the node stopped");
    expect(await i.closed).toBe("the node stopped");
    await expect(reading).rejects.toBeInstanceOf(ChannelError);
    await expect(i.fetch("/x")).rejects.toThrow(/the node stopped/);
  });

  it("answer 500 when the handler throws, and refuse streams with nothing served", async () => {
    const { i, r } = await pair({
      serve: async () => {
        throw new Error("boom");
      },
    });
    const res = await i.fetch("/x");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
    await expect(r.fetch("/y")).rejects.toThrow(/nothing is served/);
  });
});
