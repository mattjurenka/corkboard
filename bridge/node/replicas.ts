// The node's replicas: one per object it keeps (objects.ts), each kept on
// disk by the keystore as `e2ee` keeps its own, pulled at start, then
// following its log live. A change is applied at once and pushed behind
// the caller; a push that fails is tried again until it goes. Every few
// minutes each is synced whole as well, in case a socket died quietly.
//
// The account's index comes along: an object of ours the node writes that
// it doesn't list yet goes into it, and one another device adds to it is
// kept from the next sync on. A log of ours that has grown past what
// lib/e2ee thinks worth keeping is compacted as it syncs.
//
// Over sync.ts's offline transport (an account only on this machine) the
// replicas are the whole truth: changes stay queued, and nothing is pushed,
// pulled, followed or compacted until a relay's transport replaces it.

import type { CardChange } from "../../lib/e2ee/merge";
import { entries, remember } from "../../lib/e2ee/sharing";
import { type LogTransport, type ReplicaStore, Replica, memoryStore, offline } from "../../lib/e2ee/sync";
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
  private following = false;

  private constructor(
    private transport: LogTransport,
    private device: string,
    private store?: (object: string) => ReplicaStore,
    private index?: Replica,
    private discover?: () => NodeObject[],
  ) {}

  // index: the account's index, opened (objects.ts lists from it); discover:
  // what it lists now, after it's synced.
  static async open(o: { objects: NodeObject[]; transport: LogTransport; device: string; store?: (object: string) => ReplicaStore; index?: Replica; discover?: () => NodeObject[] }): Promise<Replicas> {
    const r = new Replicas(o.transport, o.device, o.store, o.index, o.discover);
    for (const obj of o.objects) await r.open(obj);
    return r;
  }

  private async open(obj: NodeObject) {
    const rep = await Replica.open({
      transport: this.transport,
      key: obj.key,
      epoch: obj.epoch,
      keyOf: obj.keyOf,
      object: obj.object,
      device: this.device,
      store: this.store?.(obj.object) ?? memoryStore(),
    });
    const k: Kept = { o: obj, rep, pushing: Promise.resolve(), synced: null, error: null };
    this.kept.set(`${obj.kind}/${obj.name}`, k);
    return k;
  }

  // An object made while the node runs (a brain the Brains tab makes): kept
  // from now on, and in the index with its first change.
  async add(obj: NodeObject): Promise<void> {
    if (this.kept.has(`${obj.kind}/${obj.name}`)) return;
    const k = await this.open(obj);
    if (!this.online) return;
    await this.sync(k);
    if (this.following) this.follow(k);
  }

  private follow(k: Kept) {
    k.stop = k.rep.live((n) => {
      k.synced = new Date().toISOString();
      if (n) this.changed(k);
    });
  }

  // Whether there's a relay: false for an account only on this machine.
  get online() {
    return this.transport !== offline;
  }

  objects(kind?: NodeObject["kind"]): NodeObject[] {
    return [...this.kept.values()].map((k) => k.o).filter((o) => !kind || o.kind === kind);
  }

  get(kind: NodeObject["kind"], name: string): Replica | undefined {
    return this.kept.get(`${kind}/${name}`)?.rep;
  }

  // Called with the object after any change to it, ours or another device's.
  // The way to stop.
  onChange(fn: (o: NodeObject) => void): () => void {
    this.listeners.push(fn);
    return () => void (this.listeners = this.listeners.filter((f) => f !== fn));
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
    await this.remember(k);
  }

  // An object of ours, written here, that the index doesn't list yet.
  private async remember(k: Kept) {
    const index = this.index;
    if (!index || k.o.owner || entries(index).some((e) => e.object === k.o.object)) return;
    try {
      await remember(index, { object: k.o.object, kind: k.o.kind, name: k.o.name, epoch: k.rep.currentEpoch });
      if (this.online) await index.push();
    } catch (e) {
      console.error(`node: ${k.o.kind} ${k.o.name} not in the index yet: ${(e as Error).message}`);
    }
  }

  // A log of ours that's worth it, compacted; behind the object's pushes.
  // A failure is only logged: the log is still whole, just long.
  private compact(rep: Replica, what: string, owner?: string): Promise<void> {
    if (owner || !this.transport.snapshot || !rep.worthCompacting) return Promise.resolve();
    return rep.compact().then(
      () => {},
      (e) => console.error(`node: compacting ${what}: ${(e as Error).message}`),
    );
  }

  // One push at a time per object; a failure is tried again later.
  private push(k: Kept): Promise<void> {
    k.pushing = k.pushing.then(async () => {
      if (!k.rep.pending || !this.online) return;
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
      k.pushing = k.pushing.then(() => this.compact(k.rep, `${k.o.kind} ${k.o.name}`, k.o.owner));
      await k.pushing;
    } catch (e) {
      k.error = (e as Error).message;
    }
  }

  private async syncIndex() {
    const index = this.index;
    if (!index) return;
    try {
      await index.sync();
      await this.compact(index, "the index");
      for (const o of this.discover?.() ?? []) if (!this.kept.has(`${o.kind}/${o.name}`)) await this.add(o);
    } catch (e) {
      console.error(`node: syncing the index: ${(e as Error).message}`);
    }
  }

  async syncAll() {
    if (!this.online) return;
    await Promise.all([this.syncIndex(), ...[...this.kept.values()].map((k) => this.sync(k))]);
  }

  // Pulls each, then follows each; live: false only syncs (a transport
  // that can't follow, or a test).
  async start(o: { live?: boolean } = {}) {
    if (!this.online) return;
    await this.syncAll();
    this.following = o.live !== false && !!this.transport.subscribe;
    if (this.following) for (const k of this.kept.values()) this.follow(k);
    this.timer = setInterval(() => void this.syncAll(), RESYNC_MS);
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
