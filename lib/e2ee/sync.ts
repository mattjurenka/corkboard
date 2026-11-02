// A replica of one object's log (a board, a brain, the account's index):
// changes are applied here at once, encrypted, and queued; push sends the
// queue, pull fetches what others wrote since the last pull, live follows
// the relay's socket. The queue holds only ciphertext, and outlives the
// process if the store does, so a change made offline goes out on the next
// push.
//
// An op that doesn't open (the wrong key, or changed on the way) is skipped
// and its id kept in rejected: a relay that mangles one op can't stop the
// rest from syncing, and can't make a replica believe anything.
//
// A log can be compacted: its owner seals the merged state up to a position
// as a snapshot, and the relay drops the ops it covers. A replica behind
// the snapshot takes its state, and applies its own queue again on top.
//
// An object's key can change (sharing it, or a member leaving, moves it to
// a new random key): each key is an epoch, every op says which sealed it,
// and the relay takes pushes only under the log's latest. A push refused
// for its epoch gets the new key (keyOf), seals the queue again under it,
// and goes again.

import { type BoardState, type CardChange, type Op, apply, cards, empty } from "./merge";
import { openRecord, sealRecord } from "./record";
import { random } from "./keys";
import { type LogRead, type NewOp, type Snapshot, type WireOp, LIMITS, b64url, fromB64url } from "./wire";

export type LogTransport = {
  append(object: string, ops: NewOp[]): Promise<{ id: string; pos: number }[]>;
  // A transport that predates snapshots and epochs answers ops and head alone.
  read(object: string, since: number, limit?: number): Promise<Pick<LogRead, "ops" | "head"> & Partial<LogRead>>;
  subscribe?(object: string, since: number, on: (ops: WireOp[], snapshot?: Snapshot) => void): () => void;
  snapshot?(object: string, s: Snapshot): Promise<void>;
};

// What a transport throws when the log has moved to another key.
export class EpochChanged extends Error {
  constructor(readonly epoch: number) {
    super(`the log is on epoch ${epoch} now`);
  }
}

export type Saved = { cursor: number; seq: number; epoch?: number; state: BoardState; outbox: NewOp[]; rejected: string[] };

export type ReplicaStore = { load(): Promise<Saved | undefined>; save(s: Saved): Promise<void> };

export const memoryStore = (): ReplicaStore & { saved?: Saved } => {
  const s: ReplicaStore & { saved?: Saved } = {
    load: async () => (s.saved ? structuredClone(s.saved) : undefined),
    save: async (v) => void (s.saved = structuredClone(v)),
  };
  return s;
};

export const newOpId = () => b64url(random(16));

// What a snapshot's record is bound to, beside its object.
export const snapshotLabel = (epoch: number, upTo: number) => `snapshot:${epoch}:${upTo}`;

function isState(s: unknown): s is BoardState {
  const o = s as BoardState;
  return !!o && typeof o === "object" && Number.isSafeInteger(o.clock) && !!o.cards && typeof o.cards === "object" && !Array.isArray(o.cards);
}

export type ReplicaOptions = {
  transport: LogTransport;
  // The key of the epoch given (0 if none is).
  key: Uint8Array;
  epoch?: number;
  // Another epoch's key, when an op, a snapshot or a refused push names
  // one this replica hasn't got; undefined if there's no such key to be had.
  keyOf?(epoch: number): Promise<Uint8Array | undefined>;
  object: string;
  device: string;
  store?: ReplicaStore;
};

export class Replica {
  private keys = new Map<number, Uint8Array>();
  private epoch: number;
  // receive runs one batch at a time, since a new epoch's key is awaited.
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private o: ReplicaOptions,
    private store: ReplicaStore,
    private s: Saved,
  ) {
    this.epoch = Math.max(o.epoch ?? 0, s.epoch ?? 0);
    this.keys.set(o.epoch ?? 0, o.key);
  }

  static async open(o: ReplicaOptions): Promise<Replica> {
    const store = o.store ?? memoryStore();
    const s = (await store.load()) ?? { cursor: 0, seq: 0, state: empty(), outbox: [], rejected: [] };
    return new Replica(o, store, s);
  }

  get object() {
    return this.o.object;
  }
  get device() {
    return this.o.device;
  }
  get cursor() {
    return this.s.cursor;
  }
  get pending() {
    return this.s.outbox.length;
  }
  get rejected(): readonly string[] {
    return this.s.rejected;
  }
  get state(): BoardState {
    return this.s.state;
  }
  get currentEpoch() {
    return this.epoch;
  }
  cards() {
    return cards(this.s.state);
  }

  private async keyFor(epoch: number): Promise<Uint8Array | undefined> {
    const had = this.keys.get(epoch);
    if (had) return had;
    const k = await this.o.keyOf?.(epoch);
    if (k) this.keys.set(epoch, k);
    return k;
  }

  private async useEpoch(epoch: number) {
    const key = await this.keyFor(epoch);
    if (!key) throw new Error(`no key for epoch ${epoch} of ${this.object}`);
    this.epoch = Math.max(this.epoch, epoch);
    this.s.epoch = this.epoch;
    return key;
  }

  private sealOp(key: Uint8Array, epoch: number, id: string, seq: number, op: Op): NewOp {
    const sealed = sealRecord(key, this.object, id, op);
    if (sealed.ciphertext.length > LIMITS.op) throw new Error(`op too big (${sealed.ciphertext.length} bytes; ${LIMITS.op} at most)`);
    return { id, seq, ...(epoch && { epoch }), nonce: b64url(sealed.nonce), ciphertext: b64url(sealed.ciphertext) };
  }

  private async openOp(o: { id: string; epoch?: number; nonce: string; ciphertext: string }): Promise<Op | undefined> {
    const key = await this.keyFor(o.epoch ?? 0);
    if (!key) return;
    try {
      return openRecord<Op>(key, this.object, o.id, { nonce: fromB64url(o.nonce), ciphertext: fromB64url(o.ciphertext) });
    } catch {
      return;
    }
  }

  // Several changes as one save; each is its own op.
  async change(...changes: CardChange[]): Promise<string[]> {
    const key = await this.keyFor(this.epoch);
    if (!key) throw new Error(`no key for epoch ${this.epoch} of ${this.object}`);
    const ids = changes.map((change) => {
      const id = newOpId();
      const op: Op = { v: 1, clock: this.s.state.clock + 1, device: this.device, change };
      apply(this.s.state, id, op);
      this.s.outbox.push(this.sealOp(key, this.epoch, id, ++this.s.seq, op));
      return id;
    });
    await this.store.save(this.s);
    return ids;
  }

  // The queue, sealed again under the log's new epoch.
  private async reseal(epoch: number) {
    const key = await this.useEpoch(epoch);
    const out: NewOp[] = [];
    for (const n of this.s.outbox) {
      if ((n.epoch ?? 0) === epoch) {
        out.push(n);
        continue;
      }
      const op = await this.openOp(n);
      if (op) out.push(this.sealOp(key, epoch, n.id, n.seq, op));
    }
    this.s.outbox = out;
    await this.store.save(this.s);
  }

  // Sends the queue in batches the relay takes; what's acknowledged leaves
  // it. A failure leaves the rest queued, and throws.
  async push(): Promise<number> {
    let sent = 0;
    let resealed = 0;
    while (this.s.outbox.length) {
      const batch: NewOp[] = [];
      let bytes = 0;
      for (const op of this.s.outbox) {
        if (batch.length >= LIMITS.batch || (batch.length && bytes + op.ciphertext.length > LIMITS.batchBytes * 0.7)) break;
        batch.push(op);
        bytes += op.ciphertext.length + op.nonce.length + op.id.length;
      }
      let acks: { id: string; pos: number }[];
      try {
        acks = await this.o.transport.append(this.object, batch);
      } catch (e) {
        if (!(e instanceof EpochChanged) || resealed++ > 2) throw e;
        await this.reseal(e.epoch);
        continue;
      }
      const acked = new Set(acks.map((a) => a.id));
      this.s.outbox = this.s.outbox.filter((o) => !acked.has(o.id));
      sent += acked.size;
      await this.store.save(this.s);
      if (!acked.size) throw new Error("relay acknowledged none of a push");
    }
    return sent;
  }

  // The state a snapshot holds, with this replica's queue on top again.
  private async takeSnapshot(snap: Snapshot): Promise<boolean> {
    if (snap.upTo <= this.s.cursor) return false;
    const key = await this.keyFor(snap.epoch);
    let state: unknown;
    try {
      if (!key) throw new Error();
      state = openRecord(key, this.object, snapshotLabel(snap.epoch, snap.upTo), { nonce: fromB64url(snap.nonce), ciphertext: fromB64url(snap.ciphertext) });
    } catch {
      this.s.rejected.push(snapshotLabel(snap.epoch, snap.upTo));
      return false;
    }
    if (!isState(state)) {
      this.s.rejected.push(snapshotLabel(snap.epoch, snap.upTo));
      return false;
    }
    for (const n of this.s.outbox) {
      const op = await this.openOp(n);
      if (op) apply(state, n.id, op);
    }
    this.s.state = state;
    this.s.cursor = snap.upTo;
    if (snap.epoch > this.epoch) await this.useEpoch(snap.epoch);
    return true;
  }

  // Ops as the relay serves them, applied; returns how many opened (this
  // device's own included: applying one twice changes nothing).
  receive(ops: WireOp[], snapshot?: Snapshot): Promise<number> {
    const run = this.queue.then(async () => {
      let n = 0;
      if (snapshot && (await this.takeSnapshot(snapshot))) n++;
      for (const w of ops) {
        if (w.pos <= this.s.cursor) continue;
        this.s.cursor = w.pos;
        const op = await this.openOp(w);
        // The device inside is what counts for the merge: the relay's
        // label is only what it was told.
        if (!op || op.device !== w.device || !apply(this.s.state, w.id, op)) this.s.rejected.push(w.id);
        else n++;
      }
      return n;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // What the last read said is kept since the snapshot.
  private kept = { count: 0, bytes: 0, head: 0 };

  async pull(): Promise<number> {
    let n = 0;
    for (;;) {
      const r = await this.o.transport.read(this.object, this.s.cursor);
      n += await this.receive(r.ops, r.snapshot);
      if (r.epoch !== undefined && r.epoch > this.epoch) await this.useEpoch(r.epoch).catch(() => {});
      this.kept = { count: r.count ?? 0, bytes: r.bytes ?? 0, head: r.head };
      if (!r.ops.length || this.s.cursor >= r.head) break;
    }
    await this.store.save(this.s);
    return n;
  }

  async sync(): Promise<{ pushed: number; pulled: number }> {
    const pushed = await this.push();
    return { pushed, pulled: await this.pull() };
  }

  // Whether the log has grown enough since its snapshot to compact it.
  get worthCompacting() {
    return this.kept.count > LIMITS.compactOps || this.kept.bytes > LIMITS.compactBytes;
  }

  private async seal(key: Uint8Array, epoch: number): Promise<Snapshot> {
    const upTo = this.s.cursor;
    const sealed = sealRecord(key, this.object, snapshotLabel(epoch, upTo), this.s.state);
    if (sealed.ciphertext.length > LIMITS.snapshot) throw new Error(`snapshot too big (${sealed.ciphertext.length} bytes; ${LIMITS.snapshot} at most)`);
    return { upTo, epoch, nonce: b64url(sealed.nonce), ciphertext: b64url(sealed.ciphertext) };
  }

  // A log with nothing in it has no position for a snapshot to cover: one
  // op that sets nothing gives it one.
  private async seed() {
    await this.sync();
    if (this.s.cursor) return;
    await this.change({ t: "card", card: "seed", set: {} });
    await this.sync();
  }

  // The log so far, as one snapshot: the owner's to do. After a sync, so the
  // state holds exactly the ops up to the cursor.
  async compact(): Promise<Snapshot | undefined> {
    if (!this.o.transport.snapshot) throw new Error("this transport can't compact a log");
    await this.sync();
    if (this.s.outbox.length || !this.s.cursor) return;
    const snap = await this.seal((await this.keyFor(this.epoch))!, this.epoch);
    await this.o.transport.snapshot(this.object, snap);
    this.kept = { count: 0, bytes: 0, head: this.kept.head };
    return snap;
  }

  // The object onto a new key: a snapshot under it at the head of the log,
  // which every member then needs the new key for. Tried again while others
  // write meanwhile.
  async rekey(key: Uint8Array, epoch = this.epoch + 1): Promise<Snapshot> {
    if (!this.o.transport.snapshot) throw new Error("this transport can't compact a log");
    if (epoch <= this.epoch) throw new Error(`epoch ${epoch} isn't after ${this.epoch}`);
    await this.seed();
    for (let tries = 0; ; tries++) {
      await this.sync();
      const snap = await this.seal(key, epoch);
      try {
        await this.o.transport.snapshot(this.object, snap);
      } catch (e) {
        if (tries < 5 && (e as { status?: number }).status === 409) continue;
        throw e;
      }
      this.keys.set(epoch, key);
      this.epoch = epoch;
      this.s.epoch = epoch;
      await this.store.save(this.s);
      return snap;
    }
  }

  // Follows the relay's socket from the cursor; returns the way to stop.
  live(on?: (n: number) => void): () => void {
    if (!this.o.transport.subscribe) throw new Error("this transport can't follow a log");
    return this.o.transport.subscribe(this.object, this.s.cursor, (ops, snapshot) => {
      void this.receive(ops, snapshot).then(async (n) => {
        await this.store.save(this.s);
        on?.(n);
      });
    });
  }

  // The queue opened, for moving it to another object (rotation.ts).
  async queued(): Promise<CardChange[]> {
    const out: CardChange[] = [];
    for (const n of this.s.outbox) {
      const op = await this.openOp(n);
      if (op) out.push(op.change);
    }
    return out;
  }
}
