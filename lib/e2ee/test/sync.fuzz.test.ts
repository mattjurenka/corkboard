import { describe, expect } from "bun:test";
import { newRoot, objectKey } from "../keys";
import { type LogTransport, Replica } from "../sync";
import { type Snapshot, type WireOp } from "../wire";
import { type Gen, fuzz } from "../../testing/fuzz";
import { Sched } from "../../testing/sched";

// Replicas under the scheduler: each device changes, pushes, pulls and
// (the owner) compacts at once, against a relay whose every answer comes
// when the scheduler says, now and then failing before it does anything,
// or doing it and losing the answer. Once it all calms down and each has
// synced, every replica has the same board, with every log entry made in
// it once.

class Flaky extends Error {}

// A relay in memory, as relay/src/log.ts keeps a log: positions, an op
// kept once by its id, a snapshot that replaces the ops it covers, and
// subscribers sent what's new.
function relay(s: Sched, g: Gen) {
  let ops: WireOp[] = [];
  let snap: Snapshot | undefined;
  let head = 0;
  const seen = new Map<string, number>();
  const subs = new Set<(ops: WireOp[], snapshot?: Snapshot) => void>();
  const r = { calm: false };
  // A point where the relay's answer waits, and may not come.
  const hop = async (lost = 0.08) => {
    if (r.calm) return;
    await s.yield();
    if (g.bool(lost)) throw new Flaky("the relay's answer was lost");
  };
  const transport = (device: string): LogTransport => ({
    async append(_, batch) {
      await hop();
      const acks = batch.map((o) => {
        const had = seen.get(o.id);
        if (had) return { id: o.id, pos: had };
        const w: WireOp = { ...o, device, pos: ++head, ts: "" };
        seen.set(o.id, w.pos);
        ops.push(w);
        for (const f of subs) f([w]);
        return { id: o.id, pos: w.pos };
      });
      await hop();
      return acks;
    },
    async read(_, since, limit = g.int(1, 6)) {
      await hop();
      const snapshot = snap && since < snap.upTo ? snap : undefined;
      const from = snapshot?.upTo ?? since;
      return { ops: ops.filter((w) => w.pos > from).slice(0, limit), head, epoch: 0, count: ops.length, bytes: 0, ...(snapshot && { snapshot }) };
    },
    async snapshot(_, sn) {
      await hop();
      if (sn.upTo > head || sn.upTo < (snap?.upTo ?? 0)) throw Object.assign(new Error("409"), { status: 409 });
      snap = sn;
      ops = ops.filter((w) => w.pos > sn.upTo);
      for (const f of subs) f([], sn);
      await hop();
    },
    subscribe(_, since, on) {
      // Each subscriber's messages in order, as on its socket.
      const lane = s.lane();
      const f = (o: WireOp[], sn?: Snapshot) => lane(() => on(o, sn));
      f(ops.filter((w) => w.pos > since), snap && since < snap.upTo ? snap : undefined);
      subs.add(f);
      return () => subs.delete(f);
    },
  });
  return { r, transport };
}

const key = objectKey(newRoot(), "board", "fuzz");

describe("replicas, fuzzed", () => {
  fuzz(
    "converge whatever runs at once, and whatever the relay loses",
    async (g, seed) => {
      const s = new Sched(g);
      const { r, transport } = relay(s, g);
      const names = ["A", "B", "C"].slice(0, g.int(2, 3));
      const reps = await Promise.all(names.map((d) => Replica.open({ transport: transport(d), key, object: `fuzz${seed}`, device: d })));
      const stops = reps.filter(() => g.bool(0.5)).map((rep) => rep.live());
      const notes: string[] = [];
      const mine: string[][] = reps.map(() => []);
      const runs: Promise<unknown>[] = [];
      for (let k = 0; k < g.int(5, 40); k++) {
        const who = g.int(0, reps.length - 1);
        const rep = reps[who];
        const what = g.pick(["change", "change", "log", "push", "pull", "sync", ...(who === 0 ? ["compact"] : [])]);
        const card = `c${g.int(1, 3)}`;
        const field = g.pick(["title", "status", "body"]);
        const note = `${rep.device}${k}`;
        if (what === "log") notes.push(note);
        // Each starts at a point of the scheduler's choosing, beside the rest.
        let wait = g.int(0, 30);
        const go = (): Promise<unknown> =>
          wait-- > 0 ? s.yield().then(go)
          : what === "change" ? rep.change({ t: "card", card, set: { [field]: k } })
          : what === "log" ? rep.change({ t: "log", card, entry: { at: String(k), who: rep.device, note } })
          : what === "push" ? rep.push()
          : what === "pull" ? rep.pull()
          : what === "sync" ? rep.sync()
          : rep.compact();
        // A device always sees what it wrote, whatever came between.
        const sees = () => {
          const have = new Set(rep.cards().flatMap((c) => c.log.map((l) => l.note)));
          for (const n of mine[who]) expect(have.has(n), `${rep.device} lost its own ${n} after ${what} ${k}`).toBe(true);
        };
        runs.push(
          s.track(
            `${rep.device} ${what} ${k}`,
            go().then(
              () => (what === "log" && mine[who].push(note), sees()),
              (e) => (sees(), e),
            ),
          ),
        );
      }
      await s.run();
      expect(s.pending(), "hung").toEqual([]);
      for (const e of await Promise.all(runs)) if (e instanceof Error && !(e instanceof Flaky) && (e as { status?: number }).status !== 409) throw e;

      // Calm: each pushes what it has, then each pulls the lot.
      r.calm = true;
      for (const f of stops) f();
      for (const rep of reps) await rep.push();
      for (const rep of reps) await rep.pull();
      await s.run();
      const want = JSON.stringify(reps[0].cards());
      for (const rep of reps) {
        expect(rep.pending).toBe(0);
        expect(rep.rejected).toEqual([]);
        expect(JSON.stringify(rep.cards()), `${rep.device} against ${reps[0].device}`).toBe(want);
      }
      const logged = reps[0].cards().flatMap((c) => c.log.map((l) => l.note));
      expect(logged.sort()).toEqual(notes.sort());
    },
    { runs: 200 },
  );
});
