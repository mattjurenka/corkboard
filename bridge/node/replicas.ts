// The node's replicas: one per object it keeps (objects.ts), each kept on
// disk by the keystore as `e2ee` keeps its own, pulled at start, then
// following its log live. A change is applied at once and pushed behind
// the caller; a push that fails is tried again until it goes. Every few
// minutes each is synced whole as well, in case a socket died quietly.

import type { CardChange } from "../../lib/e2ee/merge";
import { type LogTransport, type ReplicaStore, Replica, memoryStore } from "../../lib/e2ee/sync";
import type { NodeObject } from "./objects";

export type ObjectStatus = {
  kind: NodeObject["kind"];
  name: string;
  object: string;
  records: number;
  cursor: number;
  pending: number;
  rejected: number;
  live: boolean;
  synced: string | null;
  error: string | null;
};

type Kept = { o: NodeObject; rep: Replica; stop?: () => void; pushing: Promise<void>; retry?: Timer; synced: string | null; error: string | null };

const RETRY_MS = 10_000;
const RESYNC_MS = 5 * 60_000;

export class Replicas {
  private kept = new Map<string, Kept>();
  private listeners: ((o: NodeObject) => void)[] = [];
  private timer?: Timer;

  private constructor(private transport: LogTransport) {}

  static async open(o: { objects: NodeObject[]; transport: LogTransport; device: string; store?: (object: string) => ReplicaStore }): Promise<Replicas> {
    const r = new Replicas(o.transport);
    for (const obj of o.objects) {
      const rep = await Replica.open({ transport: o.transport, key: obj.key, object: obj.object, device: o.device, store: o.store?.(obj.object) ?? memoryStore() });
      r.kept.set(`${obj.kind}/${obj.name}`, { o: obj, rep, pushing: Promise.resolve(), synced: null, error: null });
    }
    return r;
  }

  objects(kind?: NodeObject["kind"]): NodeObject[] {
    return [...this.kept.values()].map((k) => k.o).filter((o) => !kind || o.kind === kind);
  }

  get(kind: NodeObject["kind"], name: string): Replica | undefined {
    return this.kept.get(`${kind}/${name}`)?.rep;
  }

  // Called with the object after any change to it, ours or another device's.
  onChange(fn: (o: NodeObject) => void) {
    this.listeners.push(fn);
  }

  private changed(k: Kept) {
    for (const fn of this.listeners) fn(k.o);
  }

  async change(kind: NodeObject["kind"], name: string, ...changes: CardChange[]): Promise<void> {
    const k = this.kept.get(`${kind}/${name}`);
    if (!k) throw new Error(`no ${kind} ${name} on this node`);
    if (!changes.length) return;
    await k.rep.change(...changes);
    this.changed(k);
    void this.push(k);
  }

  // One push at a time per object; a failure is tried again later.
  private push(k: Kept): Promise<void> {
    k.pushing = k.pushing.then(async () => {
      if (!k.rep.pending) return;
      try {
        await k.rep.push();
        k.error = null;
      } catch (e) {
        k.error = (e as Error).message;
        clearTimeout(k.retry);
        k.retry = setTimeout(() => void this.push(k), RETRY_MS);
      }
    });
    return k.pushing;
  }

  private async sync(k: Kept) {
    try {
      await this.push(k);
      const pulled = await k.rep.pull();
      k.synced = new Date().toISOString();
      k.error = null;
      if (pulled) this.changed(k);
    } catch (e) {
      k.error = (e as Error).message;
    }
  }

  async syncAll() {
    await Promise.all([...this.kept.values()].map((k) => this.sync(k)));
  }

  // Pulls each, then follows each; live: false only syncs (a transport
  // that can't follow, or a test).
  async start(o: { live?: boolean } = {}) {
    await this.syncAll();
    if (o.live !== false && this.transport.subscribe)
      for (const k of this.kept.values())
        k.stop = k.rep.live((n) => {
          k.synced = new Date().toISOString();
          if (n) this.changed(k);
        });
    this.timer = setInterval(() => {
      for (const k of this.kept.values()) void this.sync(k);
    }, RESYNC_MS);
  }

  // What's pushed so far, for a clean exit, and the sockets closed.
  async stop() {
    clearInterval(this.timer);
    for (const k of this.kept.values()) {
      k.stop?.();
      clearTimeout(k.retry);
      await k.pushing;
    }
  }

  // Every push queued so far, done (or failed).
  async settled() {
    await Promise.all([...this.kept.values()].map((k) => k.pushing));
  }

  status(): ObjectStatus[] {
    return [...this.kept.values()].map((k) => ({
      kind: k.o.kind,
      name: k.o.name,
      object: k.o.object,
      records: Object.keys(k.rep.state.cards).length,
      cursor: k.rep.cursor,
      pending: k.rep.pending,
      rejected: k.rep.rejected.length,
      live: !!k.stop,
      synced: k.synced,
      error: k.error,
    }));
  }
}
