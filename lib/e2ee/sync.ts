// A replica of one object's log (a board, for now): changes are applied
// here at once, encrypted, and queued; push sends the queue, pull fetches
// what others wrote since the last pull, live follows the relay's socket.
// The queue holds only ciphertext, and outlives the process if the store
// does, so a change made offline goes out on the next push.
//
// An op that doesn't open (the wrong key, or changed on the way) is skipped
// and its id kept in rejected: a relay that mangles one op can't stop the
// rest from syncing, and can't make a replica believe anything.

import { type BoardState, type CardChange, type Op, apply, cards, empty } from "./merge";
import { openRecord, sealRecord } from "./record";
import { random } from "./keys";
import { type NewOp, type WireOp, LIMITS, b64url, fromB64url } from "./wire";

export type LogTransport = {
  append(object: string, ops: NewOp[]): Promise<{ id: string; pos: number }[]>;
  read(object: string, since: number, limit?: number): Promise<{ ops: WireOp[]; head: number }>;
  subscribe?(object: string, since: number, on: (ops: WireOp[]) => void): () => void;
};

export type Saved = { cursor: number; seq: number; state: BoardState; outbox: NewOp[]; rejected: string[] };

export type ReplicaStore = { load(): Promise<Saved | undefined>; save(s: Saved): Promise<void> };

export const memoryStore = (): ReplicaStore & { saved?: Saved } => {
  const s: ReplicaStore & { saved?: Saved } = {
    load: async () => (s.saved ? structuredClone(s.saved) : undefined),
    save: async (v) => void (s.saved = structuredClone(v)),
  };
  return s;
};

export const newOpId = () => b64url(random(16));

export class Replica {
  private constructor(
    private transport: LogTransport,
    private key: Uint8Array,
    readonly object: string,
    readonly device: string,
    private store: ReplicaStore,
    private s: Saved,
  ) {}

  static async open(o: { transport: LogTransport; key: Uint8Array; object: string; device: string; store?: ReplicaStore }): Promise<Replica> {
    const store = o.store ?? memoryStore();
    const s = (await store.load()) ?? { cursor: 0, seq: 0, state: empty(), outbox: [], rejected: [] };
    return new Replica(o.transport, o.key, o.object, o.device, store, s);
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
  cards() {
    return cards(this.s.state);
  }

  // Several changes as one save; each is its own op.
  async change(...changes: CardChange[]): Promise<string[]> {
    const ids = changes.map((change) => {
      const id = newOpId();
      const op: Op = { v: 1, clock: this.s.state.clock + 1, device: this.device, change };
      apply(this.s.state, id, op);
      const sealed = sealRecord(this.key, this.object, id, op);
      if (sealed.ciphertext.length > LIMITS.op) throw new Error(`op too big (${sealed.ciphertext.length} bytes; ${LIMITS.op} at most)`);
      this.s.outbox.push({ id, seq: ++this.s.seq, nonce: b64url(sealed.nonce), ciphertext: b64url(sealed.ciphertext) });
      return id;
    });
    await this.store.save(this.s);
    return ids;
  }

  // Sends the queue in batches the relay takes; what's acknowledged leaves
  // it. A failure leaves the rest queued, and throws.
  async push(): Promise<number> {
    let sent = 0;
    while (this.s.outbox.length) {
      const batch: NewOp[] = [];
      let bytes = 0;
      for (const op of this.s.outbox) {
        if (batch.length >= LIMITS.batch || (batch.length && bytes + op.ciphertext.length > LIMITS.batchBytes * 0.7)) break;
        batch.push(op);
        bytes += op.ciphertext.length + op.nonce.length + op.id.length;
      }
      const acked = new Set((await this.transport.append(this.object, batch)).map((a) => a.id));
      this.s.outbox = this.s.outbox.filter((o) => !acked.has(o.id));
      sent += acked.size;
      await this.store.save(this.s);
      if (!acked.size) throw new Error("relay acknowledged none of a push");
    }
    return sent;
  }

  // Ops as the relay serves them, applied; returns how many opened (this
  // device's own included: applying one twice changes nothing).
  receive(ops: WireOp[]): number {
    let n = 0;
    for (const w of ops) {
      if (w.pos <= this.s.cursor) continue;
      this.s.cursor = w.pos;
      try {
        const op = openRecord<Op>(this.key, this.object, w.id, { nonce: fromB64url(w.nonce), ciphertext: fromB64url(w.ciphertext) });
        // The device inside is what counts for the merge: the relay's
        // label is only what it was told.
        if (op.device !== w.device || !apply(this.s.state, w.id, op)) this.s.rejected.push(w.id);
        else n++;
      } catch {
        this.s.rejected.push(w.id);
      }
    }
    return n;
  }

  async pull(): Promise<number> {
    let n = 0;
    for (;;) {
      const { ops, head } = await this.transport.read(this.object, this.s.cursor);
      n += this.receive(ops);
      if (!ops.length || this.s.cursor >= head) break;
    }
    await this.store.save(this.s);
    return n;
  }

  async sync(): Promise<{ pushed: number; pulled: number }> {
    const pushed = await this.push();
    return { pushed, pulled: await this.pull() };
  }

  // Follows the relay's socket from the cursor; returns the way to stop.
  live(on?: (n: number) => void): () => void {
    if (!this.transport.subscribe) throw new Error("this transport can't follow a log");
    return this.transport.subscribe(this.object, this.s.cursor, (ops) => {
      const n = this.receive(ops);
      void this.store.save(this.s);
      on?.(n);
    });
  }
}
