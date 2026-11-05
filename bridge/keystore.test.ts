import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keystore } from "./keystore";
import { accountKeys, newRoot, objectKey } from "../lib/e2ee/keys";
import { certify, newDevice } from "../lib/e2ee/device";
import { type LogTransport, Replica, memoryStore, offline } from "../lib/e2ee/sync";
import { type WireOp, b64url } from "../lib/e2ee/wire";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "corkboard-keystore-"));
  dirs.push(d);
  return new Keystore(join(d, "e2ee"));
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("the bridge's keystore", () => {
  it("keeps the root encrypted, and gives it back", async () => {
    const ks = fresh();
    const root = newRoot();
    await ks.saveRoot(root);
    expect(ks.needsPassphrase()).toBe(false);
    expect(await ks.root()).toEqual(root);
    const file = readFileSync(join(ks.dir, "root.json"), "utf8");
    expect(file).not.toContain(b64url(root));
    if (process.platform !== "win32") {
      expect(statSync(join(ks.dir, "root.json")).mode & 0o777).toBe(0o600);
      expect(statSync(ks.dir).mode & 0o777).toBe(0o700);
    }
  });

  it("under a passphrase, wants the right one", async () => {
    const ks = fresh();
    const root = newRoot();
    await ks.saveRoot(root, "correct horse");
    expect(ks.needsPassphrase()).toBe(true);
    expect(await ks.root("correct horse")).toEqual(root);
    await expect(ks.root("wrong")).rejects.toThrow(/wrong passphrase/);
    await expect(ks.root()).rejects.toThrow(/passphrase/);
  });

  it("keeps the device and its certificate", () => {
    const ks = fresh();
    const keys = accountKeys(newRoot());
    const d = newDevice();
    const cert = certify(keys, d, "laptop");
    ks.saveDevice("https://relay.test", "laptop", d, cert);
    const back = ks.device()!;
    expect(back.device.id).toBe(d.id);
    expect(back.device.box.public).toEqual(d.box.public);
    expect(back.cert).toEqual(cert);
  });
});

// A relay of one log, enough for a replica to push to and pull from.
function oneLog(): LogTransport {
  const log: WireOp[] = [];
  return {
    append: async (_o, ops) =>
      ops.map((op) => {
        log.push({ ...op, device: "laptop", pos: log.length + 1 } as WireOp);
        return { id: op.id, pos: log.length };
      }),
    read: async (_o, since) => ({ ops: log.filter((w) => w.pos > since), head: log.length }),
  };
}

describe("the keystore's replicas", () => {
  const key = objectKey(newRoot(), "brain", "assistant");
  const open = (ks: Keystore, transport: LogTransport = offline) => Replica.open({ transport, key, object: "b1", device: "laptop", store: ks.replica("b1") });

  it("come back whole from replicas.db, queue and all", async () => {
    const ks = fresh();
    const a = await open(ks);
    await a.change({ t: "card", card: "note:memory", set: { title: "Memory", body: "likes tea" } }, { t: "log", card: "entry:1", entry: { at: "now", who: "me", note: "hi" } });
    const back = await open(new Keystore(ks.dir));
    expect(back.cards()).toEqual(a.cards());
    expect(back.pending).toBe(2);
    if (process.platform !== "win32") expect(statSync(join(ks.dir, "replicas.db")).mode & 0o777).toBe(0o600);
  });

  it("write only the cards that changed, and drop what a push acknowledged", async () => {
    const ks = fresh();
    const relay = oneLog();
    const a = await open(ks, relay);
    for (let i = 0; i < 50; i++) await a.change({ t: "card", card: `entry:${i}`, set: { text: `e${i}` } });
    const db = new Database(join(ks.dir, "replicas.db"));
    const written = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM cards").get()!.n;
    // A card changed behind the replica's back isn't written by a save
    // that wasn't told of it.
    db.run("UPDATE cards SET state = 'stale' WHERE id = 'entry:0'");
    await a.change({ t: "card", card: "entry:1", set: { text: "again" } });
    expect(db.query<{ state: string }, []>("SELECT state FROM cards WHERE id = 'entry:0'").get()!.state).toBe("stale");
    expect(written()).toBe(50);
    expect(await a.push()).toBe(51);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM outbox").get()!.n).toBe(0);
    db.close();
  });

  it("move a replica in from its old JSON file", async () => {
    const ks = fresh();
    const mem = memoryStore();
    const a = await Replica.open({ transport: offline, key, object: "b1", device: "laptop", store: mem });
    await a.change({ t: "card", card: "brain", set: { name: "assistant" } });
    mkdirSync(join(ks.dir, "replicas"), { recursive: true });
    writeFileSync(join(ks.dir, "replicas", "b1.json"), JSON.stringify(mem.saved));
    const back = await open(ks);
    expect(back.cards()).toEqual(a.cards());
    expect(back.pending).toBe(1);
    expect(existsSync(join(ks.dir, "replicas", "b1.json"))).toBe(false);
  });
});
