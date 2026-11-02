import { describe, expect, it } from "bun:test";
import { type CardChange, type Op, apply, cards, empty } from "../merge";
import { newRoot, objectKey } from "../keys";
import { sealRecord } from "../record";
import { type LogTransport, Replica, memoryStore } from "../sync";
import { type NewOp, type WireOp, b64url } from "../wire";

// A seeded random, so a failure can be rerun.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const FIELDS = ["title", "status", "priority", "labels", "body"];
const VALUES: Record<string, unknown[]> = {
  title: ["a", "b", "c"],
  status: ["backlog", "doing", "done"],
  priority: ["high", "low", null],
  labels: [[], ["x"], ["x", "y"]],
  body: ["", "one", "two\nlines"],
};

// Ops as several devices would make them, each with its own Lamport clock
// that has seen some of the others'.
function history(r: () => number, n: number): [string, Op][] {
  const devices = ["dA", "dB", "dC"];
  const clocks: Record<string, number> = { dA: 0, dB: 0, dC: 0 };
  const out: [string, Op][] = [];
  for (let i = 0; i < n; i++) {
    const device = devices[Math.floor(r() * 3)];
    // Sometimes it has heard from the others.
    if (r() < 0.5) clocks[device] = Math.max(...Object.values(clocks));
    const clock = ++clocks[device];
    // And sometimes two devices land on the same clock: device then op id breaks the tie.
    const card = `task-${1 + Math.floor(r() * 4)}`;
    let change: CardChange;
    if (r() < 0.3) change = { t: "log", card, entry: { at: `t${i}`, who: device, note: `note ${i}` } };
    else {
      const set: Record<string, unknown> = {};
      for (const f of FIELDS) if (r() < 0.4) set[f] = VALUES[f][Math.floor(r() * 3)];
      change = { t: "card", card, set };
    }
    out.push([`op-${i.toString().padStart(4, "0")}-${Math.floor(r() * 1e6)}`, { v: 1, clock, device, change }]);
  }
  return out;
}

const merged = (ops: [string, Op][]) => {
  const s = empty();
  for (const [id, op] of ops) apply(s, id, op);
  return JSON.stringify(cards(s));
};

describe("merging", () => {
  it("comes to the same board whatever the order, with ops repeated", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const ops = history(r, 5 + Math.floor(r() * 60));
      const want = merged(ops);
      for (let k = 0; k < 5; k++) {
        const again = shuffle([...ops, ...ops.filter(() => r() < 0.3)], r);
        expect(merged(again)).toBe(want);
      }
    }
  });

  it("keeps the latest write to each field, and every log entry in clock order", () => {
    const s = empty();
    apply(s, "o1", { v: 1, clock: 2, device: "a", change: { t: "card", card: "c", set: { title: "new", status: "doing" } } });
    apply(s, "o2", { v: 1, clock: 1, device: "b", change: { t: "card", card: "c", set: { title: "old", priority: "high" } } });
    apply(s, "o3", { v: 1, clock: 3, device: "b", change: { t: "log", card: "c", entry: { at: "2", who: "b", note: "second" } } });
    apply(s, "o4", { v: 1, clock: 1, device: "a", change: { t: "log", card: "c", entry: { at: "1", who: "a", note: "first" } } });
    expect(cards(s)).toEqual([{ id: "c", title: "new", status: "doing", priority: "high", log: [{ at: "1", who: "a", note: "first" }, { at: "2", who: "b", note: "second" }] }]);
    expect(s.clock).toBe(3);
  });

  it("skips what it doesn't understand", () => {
    const s = empty();
    expect(apply(s, "x", { v: 2 } as never)).toBe(false);
    expect(apply(s, "x", { v: 1, clock: 1, device: "a", change: { t: "card", card: "../etc", set: {} } })).toBe(false);
    expect(apply(s, "x", { v: 1, clock: 1, device: "a", change: { t: "nope", card: "c" } as never })).toBe(false);
  });
});

// A relay in memory: server order, since, idempotent pushes; down: refuses everything.
function memoryRelay() {
  const logs = new Map<string, WireOp[]>();
  const r = {
    down: false,
    logs,
    device: "dev",
    transport(device: string): LogTransport {
      return {
        append: async (object, ops: NewOp[]) => {
          if (r.down) throw new Error("offline");
          const log = logs.get(object) ?? (logs.set(object, []), logs.get(object)!);
          return ops.map((o) => {
            const had = log.find((w) => w.id === o.id);
            if (had) return { id: o.id, pos: had.pos };
            const w = { ...o, device, pos: log.length + 1, ts: new Date().toISOString() };
            log.push(w);
            return { id: o.id, pos: w.pos };
          });
        },
        read: async (object, since, limit = 3) => {
          if (r.down) throw new Error("offline");
          const log = logs.get(object) ?? [];
          return { ops: log.filter((w) => w.pos > since).slice(0, limit), head: log.length };
        },
      };
    },
  };
  return r;
}

describe("replicas", () => {
  const root = newRoot();
  const key = objectKey(root, "board", "home");

  it("sync two devices through the relay, queueing while offline", async () => {
    const relay = memoryRelay();
    const store = memoryStore();
    const a = await Replica.open({ transport: relay.transport("A"), key, object: "obj1", device: "A", store });
    const b = await Replica.open({ transport: relay.transport("B"), key, object: "obj1", device: "B" });
    await a.change({ t: "card", card: "task-1", set: { title: "milk", status: "backlog" } });
    relay.down = true;
    await a.change({ t: "card", card: "task-1", set: { status: "doing" } }, { t: "log", card: "task-1", entry: { at: "now", who: "A", note: "went" } });
    await expect(a.push()).rejects.toThrow("offline");
    expect(a.pending).toBe(3);
    // The queue outlives the process: a replica from the store has it.
    const a2 = await Replica.open({ transport: relay.transport("A"), key, object: "obj1", device: "A", store });
    expect(a2.pending).toBe(3);
    relay.down = false;
    // Its own come back too, and change nothing.
    expect(await a2.sync()).toEqual({ pushed: 3, pulled: 3 });
    expect(await b.pull()).toBe(3);
    expect(b.cards()).toEqual(a2.cards());
    await b.change({ t: "card", card: "task-1", set: { title: "oat milk" } });
    await b.push();
    await a2.pull();
    expect(a2.cards()[0]).toMatchObject({ title: "oat milk", status: "doing", log: [{ note: "went" }] });
    expect(a2.cursor).toBe(4);
  });

  it("skip ops that don't open, and those another device's label is put on", async () => {
    const relay = memoryRelay();
    const a = await Replica.open({ transport: relay.transport("A"), key, object: "obj2", device: "A" });
    await a.change({ t: "card", card: "c", set: { title: "fine" } });
    await a.push();
    // Changed on the relay.
    const log = relay.logs.get("obj2")!;
    const bad = { ...log[0], id: "x".repeat(22), pos: 2, ciphertext: log[0].ciphertext.slice(0, -2) + "AA" };
    // Sealed by someone with the key, under another device's name.
    const op: Op = { v: 1, clock: 9, device: "A", change: { t: "card", card: "c", set: { title: "spoofed" } } };
    const s = sealRecord(key, "obj2", "y".repeat(22), op);
    const relabelled: WireOp = { id: "y".repeat(22), device: "B", seq: 1, pos: 3, nonce: b64url(s.nonce), ciphertext: b64url(s.ciphertext), ts: "" };
    // Another board's op, moved here.
    const other = sealRecord(objectKey(root, "board", "work"), "obj2", "z".repeat(22), { ...op, device: "B" });
    const moved: WireOp = { ...relabelled, id: "z".repeat(22), pos: 4, nonce: b64url(other.nonce), ciphertext: b64url(other.ciphertext) };
    log.push(bad, relabelled, moved);
    const b = await Replica.open({ transport: relay.transport("B"), key, object: "obj2", device: "B" });
    expect(await b.pull()).toBe(1);
    expect(b.cards()[0].title).toBe("fine");
    expect(b.rejected).toEqual(["x".repeat(22), "y".repeat(22), "z".repeat(22)]);
  });

  it("converge when devices push and pull in any interleaving", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed);
      const relay = memoryRelay();
      const reps = await Promise.all(["A", "B", "C"].map((d) => Replica.open({ transport: relay.transport(d), key, object: `o${seed}`, device: d })));
      for (let i = 0; i < 40; i++) {
        const rep = reps[Math.floor(r() * 3)];
        const x = r();
        if (x < 0.5) await rep.change({ t: "card", card: `c${Math.floor(r() * 3)}`, set: { [FIELDS[Math.floor(r() * 5)]]: i } });
        else if (x < 0.75) await rep.push();
        else await rep.pull();
      }
      for (const rep of reps) await rep.push();
      for (const rep of reps) await rep.pull();
      const want = JSON.stringify(reps[0].cards());
      for (const rep of reps) expect(JSON.stringify(rep.cards())).toBe(want);
    }
  });
});
