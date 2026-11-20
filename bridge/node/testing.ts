// What the node's tests share: a relay in memory, a node over replicas of
// it, and calling its /mcp. Imported by the tests, not by the node.

import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRoot } from "../../lib/e2ee/keys";
import { EpochChanged, type LogTransport, Replica } from "../../lib/e2ee/sync";
import { type NewOp, type Snapshot, type WireOp, b64url } from "../../lib/e2ee/wire";
import { dayObject, fleetObject, listObjects } from "./objects";
import { type ForgeSigner, FleetRecords } from "./fleet";
import { Replicas } from "./replicas";
import { Data } from "./data";
import { Search } from "./search";
import { Episodes } from "./episodes";
import type { Blobs } from "./handoff";
import { Media } from "./media";
import { OAuthStore } from "./oauth";
import { node } from "./server";
import type { Fleet } from "./mcp";


// A relay in memory: a log per object, ordered by pos, as the Worker keeps
// them, with its epoch and snapshot. state.pad is added to what a read
// says is kept, to make a log worth compacting; state.refuse fails snapshots.
type Log = { ops: WireOp[]; ids: Map<string, number>; head: number; epoch: number; snapshot?: Snapshot };
export function relay(): LogTransport & { state: { pad: number; refuse: boolean; logs: Map<string, Log> } } {
  const state = { pad: 0, refuse: false, logs: new Map<string, Log>() };
  const logOf = (object: string) => state.logs.get(object) ?? (state.logs.set(object, { ops: [], ids: new Map(), head: 0, epoch: 0 }), state.logs.get(object)!);
  return {
    state,
    async append(object: string, ops: NewOp[]) {
      const log = logOf(object);
      return ops.map((o) => {
        const had = log.ids.get(o.id);
        if (had) return { id: o.id, pos: had };
        if ((o.epoch ?? 0) !== log.epoch) throw new EpochChanged(log.epoch);
        const w: WireOp = { ...o, device: DEVICE_OF.get(o.id) ?? "?", pos: ++log.head, ts: new Date().toISOString() };
        log.ops.push(w);
        log.ids.set(o.id, w.pos);
        return { id: o.id, pos: w.pos };
      });
    },
    async read(object: string, since: number) {
      const log = logOf(object);
      const snap = log.snapshot && since < log.snapshot.upTo ? log.snapshot : undefined;
      const ops = log.ops.filter((w) => w.pos > (snap?.upTo ?? since));
      return { ops, head: log.head, epoch: log.epoch, count: log.ops.length && log.ops.length + state.pad, bytes: 0, ...(snap && { snapshot: snap }) };
    },
    async snapshot(object: string, s: Snapshot) {
      const log = logOf(object);
      if (state.refuse) throw new Error("no snapshots today");
      if (s.upTo > log.head || s.upTo <= (log.snapshot?.upTo ?? 0) || (s.epoch > log.epoch && s.upTo !== log.head)) throw Object.assign(new Error("conflict"), { status: 409 });
      log.snapshot = s;
      log.epoch = s.epoch;
      log.ops = log.ops.filter((w) => w.pos > s.upTo);
    },
  };
}
// The relay labels an op with the device that signed in to push it; here,
// each pushing transport says which device it is.
export const DEVICE_OF = new Map<string, string>();
export const as = <T extends LogTransport>(t: T, device: string): T => ({
  ...t,
  append: (object, ops) => {
    for (const o of ops) DEVICE_OF.set(o.id, device);
    return t.append(object, ops);
  },
});

export const ORIGIN = "https://node.test";
export const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

export async function setup(o: { fleet?: Fleet; sealed?: boolean; forge?: () => ForgeSigner | undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-node-"));
  dirs.push(dir);
  const root = newRoot();
  const shared = relay();
  const objects = [...listObjects(root, { boards: ["proj"], brains: ["assistant"] }), dayObject(root), ...(o.sealed ? [fleetObject(root)] : [])];
  const replicas = await Replicas.open({ objects, transport: as(shared, "node"), device: "node" });
  await replicas.start({ live: false });
  const data = new Data(replicas, "UTC");
  const search = new Search(data);
  const oauth = new OAuthStore(join(dir, "oauth.json"));
  const episodes = new Episodes();
  const blobs = memoryBlobs();
  const media = new Media({ data, blobs, dir: join(dir, "blobs") });
  const sealed = o.sealed ? new FleetRecords(replicas, () => o.fleet, o.forge, data) : undefined;
  const app = node({ data, search, oauth, episodes, media, origin: ORIGIN, fleet: () => o.fleet, sealed });
  // Another device of the account: the laptop, on the same relay.
  const board = objects.find((o) => o.kind === "board")!;
  const laptop = await Replica.open({ transport: as(shared, "laptop"), key: board.key, object: board.object, device: "laptop" });
  const call = (path: string, init: RequestInit = {}) => app(new Request(`${ORIGIN}${path}`, init));
  return { dir, root, shared, replicas, data, search, oauth, episodes, media, blobs, sealed, app, call, laptop, stop: () => replicas.stop() };
}

// The relay's blobs, in memory.
export function memoryBlobs(): Blobs & { kept: Map<string, Uint8Array> } {
  const kept = new Map<string, Uint8Array>();
  return {
    kept,
    putBlob: async (id, b) => (kept.has(id) ? Promise.reject(Object.assign(new Error("that blob exists"), { status: 409 })) : void kept.set(id, b)),
    getBlob: async (id) => kept.get(id) ?? Promise.reject(Object.assign(new Error("no such blob"), { status: 404 })),
    deleteBlob: async (id) => void kept.delete(id),
  };
}

export const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
export const challenge = b64url(createHash("sha256").update(verifier).digest());
export const form = (o: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
export const rpc = (method: string, params: unknown, token: string, id = 1) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
});
export const toolText = async (res: Response) => {
  const j = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { error: !!j.result.isError, text: j.result.content[0].text };
};

// For sessions.ts's serve in a test: no Worker to follow, rather than the
// account's real one with this machine's token.
export const NO_WORKER = { cloud: "http://127.0.0.1:9", token: () => Promise.reject(new Error("no Worker in a test")) };
