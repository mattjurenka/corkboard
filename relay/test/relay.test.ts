import { reset, runInDurableObject } from "cloudflare:test";
import { env as bindings, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import type { Log } from "../src/log";
import {
  type AccountKeys,
  type Device,
  type Signed,
  type DeviceCert,
  type Snapshot,
  type TunnelRequest,
  type TunnelResponse,
  type WireOp,
  EpochChanged,
  Relay,
  RelayError,
  Replica,
  accountKeys,
  answer,
  approve,
  b64url,
  certify,
  checkRotated,
  creation,
  currentKey,
  fromB64url,
  indexId,
  indexKey,
  memberKeys,
  memoryStore,
  newDevice,
  newRoot,
  nodeHandle,
  objectId,
  objectKey,
  openBlob,
  pairNew,
  remember,
  revoke,
  rotate,
  sealBlob,
  share,
  sharedWithMe,
  signGrant,
  signRotation,
  unshare,
  utf8,
} from "../../lib/e2ee";

// A relay of one's own (index.ts: routes.ts, log.ts, mailbox.ts and
// accounts.ts), driven by the clients' own library (lib/e2ee), as the
// bridge and the page drive it.

const env = bindings as unknown as Env;
const fetcher = (input: string, init?: RequestInit) => exports.default.fetch(new Request(input, init));
const ORIGIN = "https://relay.test";
const worker = (path: string, init?: RequestInit) => fetcher(`${ORIGIN}${path}`, init);
// vitest.config.ts's.
const INVITE = "invite-for-tests";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const invite = async () => INVITE;

type Account = { root: Uint8Array; keys: AccountKeys; device: Device; cert: Signed<DeviceCert>; relay: Relay };

// An account with its first device, signed up through the relay.
async function account(code?: string | null, opts: { bearer?: string } = {}): Promise<Account> {
  const root = newRoot();
  const keys = accountKeys(root);
  const device = newDevice();
  const cert = certify(keys, device, "laptop");
  const relay: Relay = new Relay({ origin: ORIGIN, fetch: fetcher, device, cert });
  await relay.createAccount(creation(keys, ORIGIN, code === undefined ? await invite() : code), cert, opts.bearer);
  return { root, keys, device, cert, relay };
}

const post = (path: string, body: unknown, token?: string) =>
  worker(path, { method: "POST", headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });

describe("accounts", () => {
  it("are made with the relay's invite, and refused without it", async () => {
    const a = await account();
    expect(await a.relay.token()).toMatch(/^cbe_/);
    await expect(account(null)).rejects.toThrow(/invite is needed/);
    await expect(account("not-the-invite")).rejects.toThrow(/not one of ours/);
    await expect(account("invite-for-test")).rejects.toThrow(/not one of ours/);
    // The same account twice.
    await expect(a.relay.createAccount(creation(a.keys, ORIGIN, INVITE), a.cert)).rejects.toThrow(/already exists/);
  });

  it("stop signing in when disabled", async () => {
    const a = await account();
    const t = await a.relay.token();
    await env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")).setE2eeStatus(a.keys.id, "disabled");
    expect((await worker("/e2ee/revoked", { headers: { Authorization: `Bearer ${t}` } })).status).toBe(401);
    await expect(a.relay.token(true)).rejects.toThrow(/disabled/);
  });

  it("need the account key's own signature, for this relay", async () => {
    const keys = accountKeys(newRoot());
    const device = newDevice();
    const cert = certify(keys, device, "x");
    const other = accountKeys(newRoot());
    const relay = new Relay({ origin: ORIGIN, fetch: fetcher });
    await expect(relay.createAccount(creation(keys, "https://elsewhere.test", await invite()), cert)).rejects.toThrow(/not this relay/);
    const forged = creation(keys, ORIGIN, await invite());
    forged.sig = creation(other, ORIGIN, forged.body.invite).sig;
    await expect(relay.createAccount(forged, cert)).rejects.toThrow(/isn't signed/);
    await expect(relay.createAccount(creation(keys, ORIGIN, await invite()), certify(other, device, "x"))).rejects.toThrow(/another account/);
  });
});

describe("signing in", () => {
  it("takes a device whose certificate chains to the account", async () => {
    const a = await account();
    const phone = newDevice();
    const r = new Relay({ origin: ORIGIN, fetch: fetcher, device: phone, cert: certify(a.keys, phone, "phone") });
    expect(await r.token()).toMatch(/^cbe_/);
    expect(await r.revoked()).toEqual([]);
  });

  it("refuses a used challenge, another device's answer, and a cert the account didn't sign", async () => {
    const a = await account();
    const { nonce } = await (await post("/e2ee/challenge", { account: a.keys.id, device: a.device.id })).json<{ nonce: string }>();
    const ans = answer(a.device, { origin: ORIGIN, nonce, account: a.keys.id });
    expect((await post("/e2ee/token", { cert: a.cert, answer: ans })).status).toBe(200);
    expect((await (await post("/e2ee/token", { cert: a.cert, answer: ans })).json<any>()).error).toMatch(/used/);
    const n2 = (await (await post("/e2ee/challenge", { account: a.keys.id, device: a.device.id })).json<{ nonce: string }>()).nonce;
    // Signed by someone else's key.
    const stranger = { ...newDevice(), id: a.device.id };
    expect((await post("/e2ee/token", { cert: a.cert, answer: answer(stranger, { origin: ORIGIN, nonce: n2, account: a.keys.id }) })).status).toBe(401);
    // A device certifying itself.
    const self = newDevice();
    const selfCert = certify({ ...a.keys, sign: self.sign }, self, "evil");
    const n3 = (await (await post("/e2ee/challenge", { account: a.keys.id, device: self.id })).json<{ nonce: string }>()).nonce;
    const res = await post("/e2ee/token", { cert: selfCert, answer: answer(self, { origin: ORIGIN, nonce: n3, account: a.keys.id }) });
    expect(res.status).toBe(401);
    // A token for nothing.
    expect((await worker("/e2ee/revoked", { headers: { Authorization: "Bearer cbe_nonsense" } })).status).toBe(401);
  });

  it("stops a revoked device at once, its tokens too, on the account's signature only", async () => {
    const a = await account();
    const phone = newDevice();
    const r = new Relay({ origin: ORIGIN, fetch: fetcher, device: phone, cert: certify(a.keys, phone, "phone") });
    const t = await r.token();
    const forged = revoke({ ...accountKeys(newRoot()), id: a.keys.id }, phone.id);
    expect((await post("/e2ee/revoke", { revocation: forged })).status).toBe(401);
    expect((await worker("/e2ee/revoked", { headers: { Authorization: `Bearer ${t}` } })).status).toBe(200);
    const real = revoke(a.keys, phone.id);
    expect((await post("/e2ee/revoke", { revocation: real })).status).toBe(200);
    expect((await worker("/e2ee/revoked", { headers: { Authorization: `Bearer ${t}` } })).status).toBe(401);
    await expect(r.token(true)).rejects.toThrow(/revoked/);
    expect(await a.relay.revoked()).toEqual([real]);
  });
});

const KEY = () => crypto.getRandomValues(new Uint8Array(32));

describe("logs", () => {
  it("keep ops in the relay's order, catch up from since, and take a repeated push once", async () => {
    const a = await account();
    const object = objectId(a.root, "board", "home");
    const op = (i: number) => ({ id: `op-${String(i).padStart(14, "0")}`, seq: i, nonce: b64url(KEY().slice(0, 24)), ciphertext: b64url(KEY()) });
    const first = await a.relay.append(object, [op(1), op(2), op(3)]);
    expect(first.map((o) => o.pos)).toEqual([1, 2, 3]);
    expect(await a.relay.append(object, [op(2), op(4)])).toEqual([{ id: op(2).id, pos: 2 }, { id: op(4).id, pos: 4 }]);
    const all = await a.relay.read(object, 0);
    expect(all.head).toBe(4);
    expect(all.ops.map((o) => o.id)).toEqual([1, 2, 3, 4].map((i) => op(i).id));
    expect(all.ops.every((o) => o.device === a.device.id)).toBe(true);
    expect((await a.relay.read(object, 2)).ops.map((o) => o.pos)).toEqual([3, 4]);
    expect((await a.relay.read(object, 0, 2)).ops).toHaveLength(2);
  });

  it("hold clients to their limits", async () => {
    const a = await account();
    const object = "o".repeat(22);
    const ok = { id: "i".repeat(22), seq: 1, nonce: b64url(new Uint8Array(24)), ciphertext: b64url(new Uint8Array(32)) };
    await expect(a.relay.append(object, [{ ...ok, ciphertext: b64url(new Uint8Array(256 * 1024 + 1)) }])).rejects.toThrow(/at most/);
    await expect(a.relay.append(object, Array.from({ length: 101 }, (_, i) => ({ ...ok, id: `${"i".repeat(20)}${i}` })))).rejects.toThrow(/at most 100/);
    await expect(a.relay.append(object, [{ ...ok, nonce: b64url(new Uint8Array(12)) }])).rejects.toThrow(/24 bytes/);
    await expect(a.relay.append(object, [{ ...ok, id: "short" }])).rejects.toThrow(/id/);
    await expect(a.relay.read("bad/../id", 0)).rejects.toThrow();
    expect((await a.relay.read(object, 0)).ops).toEqual([]);
  });

  it("are each account's own, even under the same object id", async () => {
    const a = await account();
    const b = await account();
    const object = "shared-object-id-1234";
    await a.relay.append(object, [{ id: "a".repeat(22), seq: 1, nonce: b64url(new Uint8Array(24)), ciphertext: b64url(new Uint8Array(32)) }]);
    expect((await b.relay.read(object, 0)).ops).toEqual([]);
    expect((await a.relay.read(object, 0)).ops).toHaveLength(1);
  });

  it("send what a socket missed, then each new op as it lands", async () => {
    const a = await account();
    const object = objectId(a.root, "board", "home");
    const key = objectKey(a.root, "board", "home");
    const rep = await Replica.open({ transport: a.relay, key, object, device: a.device.id });
    await rep.change({ t: "card", card: "task-1", set: { title: "one" } });
    await rep.push();
    const t = await a.relay.token();
    const res = await worker(`/e2ee/log/${object}/live?since=0`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `corkboard, corkboard.bearer.${b64url(utf8(t))}` },
    });
    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("corkboard");
    const ws = res.webSocket!;
    const got: WireOp[] = [];
    ws.addEventListener("message", (e) => void got.push(...JSON.parse(e.data as string).ops));
    ws.accept();
    await rep.change({ t: "card", card: "task-1", set: { status: "doing" } });
    await rep.push();
    await vi.waitUntil(() => got.length === 2);
    expect(got.map((o) => o.pos)).toEqual([1, 2]);
    // Another device follows along from what it got.
    const other = await Replica.open({ transport: a.relay, key, object, device: "elsewhere" });
    await other.receive(got);
    expect(other.cards()).toEqual([{ id: "task-1", title: "one", status: "doing", log: [] }]);
    ws.close();
    // Without a token, no socket.
    expect((await worker(`/e2ee/log/${object}/live`, { headers: { Upgrade: "websocket" } })).status).toBe(401);
  });

  it("never hold plaintext: what's stored is ciphertext the relay has no key to", async () => {
    const a = await account();
    const object = objectId(a.root, "board", "secret-board");
    const key = objectKey(a.root, "board", "secret-board");
    const rep = await Replica.open({ transport: a.relay, key, object, device: a.device.id });
    const SECRET = "the launch codes are 0000";
    await rep.change({ t: "card", card: "task-1", set: { title: SECRET, body: SECRET } }, { t: "log", card: "task-1", entry: { at: "now", who: "me", note: SECRET } });
    await rep.push();
    const stub = env.LOG.get(env.LOG.idFromName(`${a.keys.id}/${object}`));
    const stored = await runInDurableObject(stub, (_o: Log, state) => {
      const rows = state.storage.sql.exec("SELECT * FROM ops").toArray();
      return rows.map((r) => Object.values(r).map((v) => (v instanceof ArrayBuffer ? new TextDecoder("latin1").decode(v) : String(v))).join("|")).join("\n");
    });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("launch");
    expect(stored).not.toContain("secret-board");
    expect(stored).not.toContain("task-1");
    // An attachment, likewise.
    const blobKey = KEY();
    const id = b64url(KEY().slice(0, 16));
    await a.relay.putBlob(id, sealBlob(blobKey, id, utf8(SECRET.repeat(100))));
    const raw = await env.MEDIA.get(`e2ee/${a.keys.id}/${id}`);
    expect(new TextDecoder("latin1").decode(await raw!.arrayBuffer())).not.toContain("launch");
    expect(new TextDecoder().decode(openBlob(blobKey, id, await a.relay.getBlob(id)))).toBe(SECRET.repeat(100));
    await expect(a.relay.putBlob(id, sealBlob(blobKey, id, utf8("again")))).rejects.toThrow(/exists/);
    // And another account can't fetch it.
    const b = await account();
    await expect(b.relay.getBlob(id)).rejects.toThrow(/404/);
  });
});

const fast = { interval: 5 };

// The person comparing the two screens' six digits.
function person() {
  let a!: (s: string) => void, b!: (s: string) => void;
  const onNew = new Promise<string>((r) => (a = r));
  const onOld = new Promise<string>((r) => (b = r));
  return { newSide: async (s: string) => (a(s), s === (await onOld)), oldSide: async (s: string) => (b(s), s === (await onNew)) };
}

describe("pairing through the relay", () => {
  it("gives a new device the root, which then signs in and reads the board", async () => {
    const a = await account();
    const object = objectId(a.root, "board", "home");
    const rep = await Replica.open({ transport: a.relay, key: objectKey(a.root, "board", "home"), object, device: a.device.id });
    await rep.change({ t: "card", card: "task-1", set: { title: "paired" } });
    await rep.push();

    const phone = newDevice();
    const p = person();
    let code = "";
    const fresh = new Relay({ origin: ORIGIN, fetch: fetcher });
    const [got] = await Promise.all([
      pairNew(fresh, phone, "phone", { show: (c) => (code = c), confirm: p.newSide }, fast),
      (async () => {
        await vi.waitUntil(() => code);
        return approve(a.relay, a.root, code, { confirm: p.oldSide }, fast);
      })(),
    ]);
    expect(got.root).toEqual(a.root);
    const r = new Relay({ origin: ORIGIN, fetch: fetcher, device: phone, cert: got.cert });
    const theirs = await Replica.open({ transport: r, key: objectKey(got.root, "board", "home"), object: objectId(got.root, "board", "home"), device: phone.id });
    await theirs.pull();
    expect(theirs.cards()[0].title).toBe("paired");
    // The mailbox is gone once read.
    expect((await post(`/e2ee/pair/${code}`, { secret: "whatever" })).status).toBe(404);
  });

  it("lets only the committing account see the new device, and nobody without a token approve", async () => {
    const a = await account();
    const b = await account();
    const { code, secret } = await (await post("/e2ee/pair", {})).json<{ code: string; secret: string }>();
    expect((await post(`/e2ee/pair/${code}/commit`, { commit: "A".repeat(43) })).status).toBe(401);
    // Joining before anyone has committed is refused: the new device waits.
    expect((await post(`/e2ee/pair/${code}/join`, { secret, box: "B".repeat(43), device: "C".repeat(43), name: "phone" })).status).toBe(409);
    await a.relay.commit(code, "A".repeat(43));
    await expect(b.relay.commit(code, "A".repeat(43))).rejects.toThrow(/already/);
    expect((await post(`/e2ee/pair/${code}/join`, { secret: "wrong", box: "B".repeat(43), device: "C".repeat(43), name: "phone" })).status).toBe(403);
    expect((await post(`/e2ee/pair/${code}/join`, { secret, box: "B".repeat(43), device: "C".repeat(43), name: "phone" })).status).toBe(200);
    expect((await a.relay.view(code)).join?.device).toBe("C".repeat(43));
    await expect(b.relay.view(code)).rejects.toThrow(/another account/);
    await expect(b.relay.reveal(code, "D".repeat(43))).rejects.toThrow(/another account/);
    // Codes are forgiving of how they're typed.
    expect((await a.relay.view(`${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`)).code).toBe(code);
    await a.relay.cancel(code);
    expect((await post(`/e2ee/pair/${code}`, { secret })).status).toBe(404);
  });
});

// An op as a client would send it, with nothing inside worth opening.
const rawOp = (i: number, epoch?: number) => ({ id: `op-${String(i).padStart(14, "0")}`, seq: i, ...(epoch !== undefined && { epoch }), nonce: b64url(KEY().slice(0, 24)), ciphertext: b64url(KEY()) });
const rawSnapshot = (upTo: number, epoch = 0, bytes = 48): Snapshot => ({ upTo, epoch, nonce: b64url(KEY().slice(0, 24)), ciphertext: b64url(new Uint8Array(bytes).map((_, i) => (i * 31 + upTo) & 255)) });

// A replica of one of the account's own objects.
const replica = (a: Account, kind: "board" | "brain", name: string, device = a.device.id) =>
  Replica.open({ transport: a.relay, key: objectKey(a.root, kind, name), object: objectId(a.root, kind, name), device });
const indexOf = (a: Account) => Replica.open({ transport: a.relay, key: indexKey(a.root), object: indexId(a.root), device: a.device.id });

describe("snapshots", () => {
  it("replace the ops they cover, and a repeated push of one still gets its old position", async () => {
    const a = await account();
    const object = objectId(a.root, "board", "home");
    await a.relay.append(object, [rawOp(1), rawOp(2), rawOp(3)]);
    const snap = rawSnapshot(2);
    await a.relay.snapshot(object, snap);
    const r = await a.relay.read(object, 0);
    expect(r.snapshot).toEqual(snap);
    expect(r.ops.map((o) => o.pos)).toEqual([3]);
    expect(r).toMatchObject({ head: 3, epoch: 0, count: 1, bytes: 32 });
    // Past the snapshot, it isn't sent again.
    expect((await a.relay.read(object, 2)).snapshot).toBeUndefined();
    // The ops it covers are gone, but not forgotten.
    const stub = env.LOG.get(env.LOG.idFromName(`${a.keys.id}/${object}`));
    expect(await runInDurableObject(stub, (_o: Log, state) => state.storage.sql.exec("SELECT pos FROM ops").toArray().map((x) => x.pos))).toEqual([3]);
    expect(await a.relay.append(object, [rawOp(1), rawOp(4)])).toEqual([{ id: rawOp(1).id, pos: 1 }, { id: rawOp(4).id, pos: 4 }]);
    // Each must be past the last, at or before the head; a new epoch's must be at the head.
    await expect(a.relay.snapshot(object, rawSnapshot(2))).rejects.toMatchObject({ status: 409 });
    await expect(a.relay.snapshot(object, rawSnapshot(9))).rejects.toMatchObject({ status: 400 });
    await expect(a.relay.snapshot(object, rawSnapshot(3, 1))).rejects.toMatchObject({ status: 409 });
    await expect(a.relay.snapshot(object, { ...rawSnapshot(3), nonce: b64url(new Uint8Array(12)) })).rejects.toThrow(/24 bytes/);
    // A big one is kept in parts, and read back whole; at the head it raises the epoch.
    const big = rawSnapshot(4, 1, 2.5 * 1024 * 1024);
    await a.relay.snapshot(object, big);
    expect(await runInDurableObject(stub, (_o: Log, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM snapshot_parts").one().n)).toBe(3);
    const after = await a.relay.read(object, 0);
    expect(after.snapshot).toEqual(big);
    expect(after).toMatchObject({ ops: [], head: 4, epoch: 1, count: 0, bytes: 0 });
    await expect(a.relay.snapshot(object, rawSnapshot(4, 0))).rejects.toMatchObject({ status: 409 });
    // Now a push under the old epoch is refused, saying the new one; one it had is still answered.
    await expect(a.relay.append(object, [rawOp(5)])).rejects.toEqual(new EpochChanged(1));
    expect(await a.relay.append(object, [rawOp(2, 0), rawOp(5, 1)])).toEqual([{ id: rawOp(2).id, pos: 2 }, { id: rawOp(5).id, pos: 5 }]);
    expect((await a.relay.read(object, 4)).ops[0]).toMatchObject({ pos: 5, epoch: 1 });
    // A new key with nothing written since the last snapshot: at the same position.
    await a.relay.snapshot(object, rawSnapshot(5, 2));
    await a.relay.snapshot(object, rawSnapshot(5, 3));
    await expect(a.relay.snapshot(object, rawSnapshot(5, 3))).rejects.toMatchObject({ status: 409 });
    expect((await a.relay.read(object, 0)).epoch).toBe(3);
    // The owner deletes the whole log.
    await a.relay.deleteLog(object);
    expect(await a.relay.read(object, 0)).toEqual({ ops: [], head: 0, epoch: 0, count: 0, bytes: 0 });
  });

  it("take a log from before epochs as epoch 0", async () => {
    const a = await account();
    const object = "o".repeat(22);
    const stub = env.LOG.get(env.LOG.idFromName(`${a.keys.id}/${object}`));
    await runInDurableObject(stub, (o: Log, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE ops");
      sql.exec("CREATE TABLE ops (pos INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, device TEXT NOT NULL, seq INTEGER NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, ts TEXT NOT NULL)");
      sql.exec("INSERT INTO ops (id, device, seq, nonce, ciphertext, ts) VALUES (?, 'd', 1, ?, ?, 'then')", rawOp(1).id, new Uint8Array(24), new Uint8Array(32));
      (o as unknown as { schema(): void }).schema();
    });
    await a.relay.append(object, [rawOp(2)]);
    const r = await a.relay.read(object, 0);
    expect(r.ops.map((o) => [o.pos, o.epoch])).toEqual([
      [1, undefined],
      [2, undefined],
    ]);
  });

  it("are what Replica.compact makes, and what another replica catches up from", async () => {
    const a = await account();
    const rep = await replica(a, "board", "home");
    for (let i = 1; i <= 5; i++) await rep.change({ t: "card", card: `task-${i}`, set: { title: `t${i}` } });
    await rep.push();
    await rep.change({ t: "log", card: "task-1", entry: { at: "now", who: "me", note: "hi" } });
    const snap = await rep.compact();
    expect(snap?.upTo).toBe(6);
    expect((await a.relay.read(rep.object, 0)).ops).toEqual([]);
    await rep.change({ t: "card", card: "task-2", set: { status: "done" } });
    await rep.push();
    const other = await Replica.open({ transport: a.relay, key: objectKey(a.root, "board", "home"), object: rep.object, device: "elsewhere", store: memoryStore() });
    await other.pull();
    expect(other.cards()).toEqual(rep.cards());
    expect(other.cursor).toBe(7);
    // A socket from the start gets the snapshot first, then the ops after it.
    const t = await a.relay.token();
    const res = await worker(`/e2ee/log/${rep.object}/live?since=0`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `corkboard, corkboard.bearer.${b64url(utf8(t))}` } });
    const ws = res.webSocket!;
    const got: { ops?: WireOp[]; snapshot?: Snapshot }[] = [];
    ws.addEventListener("message", (e) => void got.push(JSON.parse(e.data as string)));
    ws.accept();
    await vi.waitUntil(() => got.length === 2);
    expect(got[0].snapshot?.upTo).toBe(6);
    expect(got[1].ops?.map((o) => o.pos)).toEqual([7]);
    ws.close();
  });

  it("move a log to a new epoch, and a stale replica's queue is sealed again for it", async () => {
    const a = await account();
    const rep = await replica(a, "board", "home");
    await rep.change({ t: "card", card: "task-1", set: { title: "one" } });
    await rep.push();
    const key = KEY();
    const phone = await Replica.open({ transport: a.relay, key: objectKey(a.root, "board", "home"), keyOf: async (e) => (e === 1 ? key : undefined), object: rep.object, device: a.device.id });
    await phone.pull();
    await phone.change({ t: "card", card: "task-1", set: { status: "doing" } });
    await rep.rekey(key);
    expect(rep.currentEpoch).toBe(1);
    // The phone's push is refused for its epoch, sealed again under the new key, and taken.
    expect(await phone.push()).toBe(1);
    expect(phone.currentEpoch).toBe(1);
    const r = await a.relay.read(rep.object, 0);
    expect(r.epoch).toBe(1);
    expect(r.ops.map((o) => o.epoch)).toEqual([1]);
    await rep.pull();
    expect(rep.cards()).toEqual([{ id: "task-1", title: "one", status: "doing", log: [] }]);
    // Someone reading from scratch with only the old key can't get past the snapshot.
    const stale = await Replica.open({ transport: a.relay, key: objectKey(a.root, "board", "home"), object: rep.object, device: "stale" });
    await stale.pull();
    expect(stale.cards()).toEqual([]);
    expect(stale.rejected.length).toBeGreaterThan(0);
  });
});

describe("sharing", () => {
  it("lets a member read the owner's log, and with read only, not write", async () => {
    const a = await account();
    const b = await account();
    const c = await account();
    const index = await indexOf(a);
    const rep = await replica(a, "brain", "notes");
    await rep.change({ t: "card", card: "note:1", set: { title: "shared note" } });
    await rep.push();
    await share(a.relay, a.root, a.keys.id, index, rep, { kind: "brain", name: "notes", member: await a.relay.accountView(b.keys.id), role: "read" });
    expect(rep.currentEpoch).toBe(1);

    const { objects, bad } = await sharedWithMe(b.relay, b.keys, b.keys.id);
    expect(bad).toEqual([]);
    expect(objects).toEqual([expect.objectContaining({ owner: a.keys.id, object: rep.object, kind: "brain", name: "notes", role: "read", epoch: 1 })]);
    const theirs = await Replica.open({
      transport: b.relay.shares(a.keys.id),
      key: objects[0].key,
      epoch: objects[0].epoch,
      keyOf: memberKeys(b.relay, b.keys, b.keys.id, a.keys.id, rep.object),
      object: rep.object,
      device: b.device.id,
    });
    await theirs.pull();
    expect(theirs.cards()).toEqual([{ id: "note:1", title: "shared note", log: [] }]);
    await theirs.change({ t: "card", card: "note:1", set: { title: "mine now" } });
    await expect(theirs.push()).rejects.toMatchObject({ status: 403 });

    // Nobody else gets in, and only the owner compacts or deletes.
    await expect(c.relay.read(rep.object, 0, undefined, a.keys.id)).rejects.toMatchObject({ status: 403 });
    const bt = await b.relay.token();
    const auth = { Authorization: `Bearer ${bt}`, "Content-Type": "application/json" };
    expect((await worker(`/e2ee/log/${rep.object}/snapshot?owner=${a.keys.id}`, { method: "POST", headers: auth, body: JSON.stringify(rawSnapshot(1, 1)) })).status).toBe(403);
    expect((await worker(`/e2ee/log/${rep.object}?owner=${a.keys.id}`, { method: "DELETE", headers: auth })).status).toBe(403);
    // A socket, likewise.
    const live = (t: string) => worker(`/e2ee/log/${rep.object}/live?owner=${a.keys.id}`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `corkboard, corkboard.bearer.${b64url(utf8(t))}` } });
    expect((await live(bt)).status).toBe(101);
    expect((await live(await c.relay.token())).status).toBe(403);

    // The object's files, likewise, read only.
    const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const sealed = sealBlob(objects[0].key, id, utf8("a file"));
    await a.relay.putBlob(id, sealed);
    const of = { owner: a.keys.id, object: rep.object };
    expect(new TextDecoder().decode(openBlob(objects[0].key, id, await b.relay.getBlob(id, of)))).toBe("a file");
    await expect(b.relay.getBlob(id)).rejects.toMatchObject({ status: 404 });
    await expect(c.relay.getBlob(id, of)).rejects.toMatchObject({ status: 403 });
    await expect(b.relay.getBlob(id, { ...of, object: b64url(crypto.getRandomValues(new Uint8Array(16))) })).rejects.toMatchObject({ status: 403 });
    expect((await worker(`/e2ee/blob/${id}?owner=${a.keys.id}&object=${rep.object}`, { method: "DELETE", headers: auth })).status).toBe(403);
  });

  it("are listed for the owner and to the member, and checked as they're made", async () => {
    const a = await account();
    const b = await account();
    const index = await indexOf(a);
    const rep = await replica(a, "brain", "notes");
    await share(a.relay, a.root, a.keys.id, index, rep, { kind: "brain", name: "notes", member: await a.relay.accountView(b.keys.id), role: "write" });
    const mine = await a.relay.grants(rep.object);
    expect(mine).toHaveLength(1);
    expect(mine[0].grant.body).toMatchObject({ owner: a.keys.id, object: rep.object, member: b.keys.id, role: "write", epoch: 1 });
    expect(await b.relay.shared()).toEqual(mine);
    expect(await a.relay.shared()).toEqual([]);
    expect(await b.relay.grants(rep.object)).toEqual([]);

    const { grant, sealed } = mine[0];
    // Signed by someone else, for another owner, with a box it didn't sign for, to nobody.
    await expect(a.relay.grant(signGrant(b.keys, grant.body), sealed)).rejects.toMatchObject({ status: 401 });
    await expect(b.relay.grant(signGrant(b.keys, grant.body), sealed)).rejects.toMatchObject({ status: 403 });
    await expect(a.relay.grant(grant, b64url(crypto.getRandomValues(new Uint8Array(120))))).rejects.toThrow(/SHA-256/);
    const nobody = accountKeys(newRoot()).id;
    await expect(a.relay.grant(signGrant(a.keys, { ...grant.body, member: nobody }), sealed)).rejects.toMatchObject({ status: 404 });
    await expect(a.relay.grant(signGrant(a.keys, { ...grant.body, member: a.keys.id }), sealed)).rejects.toMatchObject({ status: 400 });
    // An older one doesn't replace a newer; a newer replaces it.
    await expect(a.relay.grant(signGrant(a.keys, { ...grant.body, at: grant.body.at - 1 }), sealed)).rejects.toMatchObject({ status: 409 });
    const later = signGrant(a.keys, { ...grant.body, role: "read", at: grant.body.at + 1 });
    await a.relay.grant(later, sealed);
    expect(await a.relay.grants(rep.object)).toEqual([{ grant: later, sealed }]);
    await a.relay.ungrant(rep.object, b.keys.id);
    expect(await b.relay.shared()).toEqual([]);
  });

  it("end with unshare, and the member left follows the object to its new key", async () => {
    const a = await account();
    const b = await account();
    const c = await account();
    const index = await indexOf(a);
    const rep = await replica(a, "brain", "notes");
    await rep.change({ t: "card", card: "note:1", set: { title: "first" } });
    await rep.push();
    await share(a.relay, a.root, a.keys.id, index, rep, { kind: "brain", name: "notes", member: await a.relay.accountView(b.keys.id), role: "write" });
    await share(a.relay, a.root, a.keys.id, index, rep, { kind: "brain", name: "notes", member: await a.relay.accountView(c.keys.id), role: "read" });
    const open = async (m: Account) => {
      const o = (await sharedWithMe(m.relay, m.keys, m.keys.id)).objects[0];
      return Replica.open({ transport: m.relay.shares(a.keys.id), key: o.key, epoch: o.epoch, keyOf: memberKeys(m.relay, m.keys, m.keys.id, a.keys.id, rep.object), object: rep.object, device: m.device.id });
    };
    const bs = await open(b);
    const cs = await open(c);
    await cs.pull();
    expect(cs.cards()[0].title).toBe("first");
    await bs.change({ t: "card", card: "note:2", set: { title: "from b" } });
    await bs.push();

    await unshare(a.relay, a.root, a.keys.id, index, rep, c.keys.id);
    expect(rep.currentEpoch).toBe(2);
    await expect(cs.pull()).rejects.toMatchObject({ status: 403 });
    expect((await sharedWithMe(c.relay, c.keys, c.keys.id)).objects).toEqual([]);
    // b's next push is refused for the epoch, gets the key from its new grant, and goes.
    await bs.change({ t: "card", card: "note:1", set: { title: "edited by b" } });
    await bs.push();
    expect(bs.currentEpoch).toBe(2);
    await bs.pull();
    await rep.pull();
    expect(rep.cards().map((x) => x.title)).toEqual(["edited by b", "from b"]);
    expect(bs.cards()).toEqual(rep.cards());
  });
});

describe("accounts' keys", () => {
  it("are anyone's to see, with the proof they're the id's", async () => {
    const a = await account();
    const b = await account();
    const view = await a.relay.accountView(b.keys.id);
    expect(view).toMatchObject({ id: b.keys.id, key: b.keys.id, box: b64url(b.keys.box.public), proof: { rotations: [] } });
    expect(currentKey(view, b.keys.id)).toBe(b.keys.id);
    expect(currentKey({ ...view, box: b64url(a.keys.box.public) }, b.keys.id)).toBeUndefined();
    expect(currentKey(view, a.keys.id)).toBeUndefined();
    await expect(a.relay.accountView(accountKeys(newRoot()).id)).rejects.toMatchObject({ status: 404 });
    expect((await worker(`/e2ee/accounts/${b.keys.id}`)).status).toBe(401);
  });

  it("of an account made before creations were kept, are served with none", async () => {
    const a = await account();
    const id = accountKeys(newRoot()).id;
    await runInDurableObject(env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")), (_o, state) => {
      const doc = { id, box: "B".repeat(43), status: "active", created: new Date().toISOString(), invite: null, by: null };
      state.storage.sql.exec("INSERT INTO e2ee_accounts (id, doc) VALUES (?, ?)", id, JSON.stringify(doc));
    });
    const view = await a.relay.accountView(id);
    expect(view).toEqual({ id, key: id, box: "B".repeat(43), proof: { creation: null, rotations: [] } });
    expect(currentKey(view, id)).toBeUndefined();
  });
});

describe("rotation", () => {
  it("moves the account onto a new key: old tokens end, kept devices follow, shared objects keep their ids", async () => {
    const a = await account();
    const b = await account();
    const signedIn = (device: Device, cert: Signed<DeviceCert>) => new Relay({ origin: ORIGIN, fetch: fetcher, device, cert });
    const phone = newDevice();
    const phoneCert = certify(a.keys, phone, "phone");
    const phoneRelay = signedIn(phone, phoneCert);
    const tablet = newDevice();
    const tabletRelay = signedIn(tablet, certify(a.keys, tablet, "tablet"));
    await phoneRelay.token();
    await tabletRelay.token();

    // A board of its own, and a brain shared with b; both in the index.
    const index = await indexOf(a);
    const board = await replica(a, "board", "home");
    await board.change({ t: "card", card: "task-1", set: { title: "kept" } }, { t: "log", card: "task-1", entry: { at: "now", who: "me", note: "logged" } });
    await board.push();
    await remember(index, { object: board.object, kind: "board", name: "home", epoch: 0 });
    await index.push();
    const brain = await replica(a, "brain", "notes");
    await brain.change({ t: "card", card: "note:1", set: { title: "shared" } });
    await brain.push();
    await share(a.relay, a.root, a.keys.id, index, brain, { kind: "brain", name: "notes", member: await a.relay.accountView(b.keys.id), role: "read" });
    const so = (await sharedWithMe(b.relay, b.keys, b.keys.id)).objects[0];
    const bs = await Replica.open({ transport: b.relay.shares(a.keys.id), key: so.key, epoch: so.epoch, keyOf: memberKeys(b.relay, b.keys, b.keys.id, a.keys.id, brain.object), object: brain.object, device: b.device.id });
    await bs.pull();

    const laptop = new Relay({ origin: ORIGIN, fetch: fetcher, device: a.device, cert: a.cert });
    const oldToken = await laptop.token();
    let kept: Uint8Array | undefined;
    const result = await rotate(laptop, a.root, a.keys.id, a.device, [a.cert.body, phoneCert.body], {
      replica: (_root, object, key, epoch) => Replica.open({ transport: laptop, key, epoch, object, device: a.device.id, store: memoryStore() }),
      keepRoot: async (r) => void (kept = r),
    });
    const next = accountKeys(result.root);
    expect(kept).toEqual(result.root);
    expect(laptop.account).toBe(a.keys.id);

    // The old key's tokens and certs are done with.
    expect((await worker("/e2ee/revoked", { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    await expect(a.relay.token(true)).rejects.toMatchObject({ status: 401 });
    // Its keys now, with the proof.
    const view = await b.relay.accountView(a.keys.id);
    expect(view.key).toBe(next.id);
    expect(currentKey(view, a.keys.id)).toBe(next.id);

    // The phone, kept: refused with its old cert, it fetches its way on and signs in.
    await expect(phoneRelay.revoked()).rejects.toMatchObject({ status: 401 });
    const got = checkRotated(await phoneRelay.rotated(a.keys.id, phone.id), a.keys.id, phone);
    expect(got.root).toEqual(result.root);
    phoneRelay.useCert(got.cert);
    expect((await phoneRelay.signIn()).account).toBe(a.keys.id);
    expect(phoneRelay.account).toBe(a.keys.id);
    const moved = await Replica.open({ transport: phoneRelay, key: objectKey(got.root, "board", "home"), object: objectId(got.root, "board", "home"), device: phone.id });
    await moved.pull();
    expect(moved.cards()).toEqual([{ id: "task-1", title: "kept", log: [{ at: "now", who: "me", note: "logged" }] }]);
    // Its logs are still under the account's id.
    const stub = env.LOG.get(env.LOG.idFromName(`${a.keys.id}/${moved.object}`));
    expect(await runInDurableObject(stub, (o: Log) => o.head())).toBeGreaterThan(0);
    // The old board's log is gone.
    expect((await phoneRelay.read(board.object, 0)).ops).toEqual([]);

    // The tablet, left out, has nothing to fetch and can't sign in.
    await expect(tabletRelay.revoked()).rejects.toMatchObject({ status: 401 });
    await expect(tabletRelay.rotated(a.keys.id, tablet.id)).rejects.toMatchObject({ status: 404 });
    // Revocations are now the new key's.
    await expect(a.relay.revoke(revoke(a.keys, tablet.id))).rejects.toMatchObject({ status: 401 });
    await phoneRelay.revoke(revoke(next, tablet.id));
    expect((await phoneRelay.revoked()).map((r) => r.body.device)).toEqual([tablet.id]);
    // A rotation from a key the account no longer has is refused.
    const again = accountKeys(newRoot());
    const stale = signRotation(a.keys, { v: 1, account: a.keys.id, from: a.keys.id, to: again.id, box: b64url(again.box.public), at: Date.now() });
    await expect(laptop.rotate(stale, [certify(again, a.device, "laptop")], { [a.device.id]: b64url(new Uint8Array(80)) })).rejects.toMatchObject({ status: 409 });

    // The shared brain kept its id; b follows it to its new key and reads on.
    const after = (await sharedWithMe(b.relay, b.keys, b.keys.id)).objects;
    expect(after).toEqual([expect.objectContaining({ owner: a.keys.id, object: brain.object, epoch: 2 })]);
    await brain.change({ t: "card", card: "note:2", set: { title: "after" } });
    await expect(brain.push()).rejects.toMatchObject({ status: 401 });
    const brainNow = await Replica.open({ transport: phoneRelay, key: after[0].key, epoch: 2, object: brain.object, device: phone.id });
    await brainNow.change({ t: "card", card: "note:2", set: { title: "after" } });
    await brainNow.push();
    await bs.pull();
    expect(bs.cards().map((x) => x.title)).toEqual(["shared", "after"]);
  });

  it("is refused unless it's the account's key now, from a device of the account", async () => {
    const a = await account();
    const b = await account();
    const next = accountKeys(newRoot());
    const rot = (from: AccountKeys, account = a.keys.id) => signRotation(from, { v: 1, account, from: from.id, to: next.id, box: b64url(next.box.public), at: Date.now() });
    const cert = certify(next, a.device, "laptop");
    const roots = { [a.device.id]: b64url(new Uint8Array(80)) };
    await expect(b.relay.rotate(rot(a.keys), [cert], roots)).rejects.toMatchObject({ status: 403 });
    await expect(a.relay.rotate(rot(b.keys), [cert], roots)).rejects.toMatchObject({ status: 409 });
    await expect(a.relay.rotate({ ...rot(a.keys), sig: rot(b.keys, a.keys.id).sig }, [cert], roots)).rejects.toMatchObject({ status: 401 });
    await expect(a.relay.rotate(rot(a.keys), [certify(a.keys, a.device, "laptop")], roots)).rejects.toThrow(/new key/);
    await expect(a.relay.rotate(rot(a.keys), [cert], {})).rejects.toThrow(/sealed/);
    await expect(a.relay.rotate(rot(a.keys), [cert], { ...roots, [b.device.id]: roots[a.device.id] })).rejects.toThrow(/isn't kept/);
    // The new key can't be another account's.
    const taken = signRotation(a.keys, { v: 1, account: a.keys.id, from: a.keys.id, to: b.keys.id, box: b64url(b.keys.box.public), at: Date.now() });
    await expect(a.relay.rotate(taken, [certify(b.keys, a.device, "laptop")], roots)).rejects.toMatchObject({ status: 409 });
    await a.relay.rotate(rot(a.keys), [cert], roots);
  });
});

describe("nodes and the tunnel", () => {
  // A device's node socket, answering each request with who it is and what it got.
  async function node(relay: Relay, name: string) {
    const t = await relay.token();
    const res = await worker(`/e2ee/nodes/live?name=${name}`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `corkboard, corkboard.bearer.${b64url(utf8(t))}` } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.addEventListener("message", (e) => {
      const r = JSON.parse(e.data as string) as TunnelRequest;
      const got = { name, method: r.method, path: r.path, headers: Object.fromEntries(r.headers), body: r.body ? new TextDecoder().decode(fromB64url(r.body)) : null };
      ws.send(JSON.stringify({ id: r.id, status: 200, headers: [["content-type", "application/json"], ["x-node", name]], body: b64url(utf8(JSON.stringify(got))) } satisfies TunnelResponse));
    });
    ws.accept();
    return ws;
  }

  it("forward to the leader when it's connected, else to the newest node", async () => {
    const a = await account();
    const phone = newDevice();
    const phoneRelay = new Relay({ origin: ORIGIN, fetch: fetcher, device: phone, cert: certify(a.keys, phone, "phone") });
    const handle = await nodeHandle(a.keys.id);
    const n = await a.relay.nodes();
    expect(n).toEqual({ handle, url: `${ORIGIN}/n/${handle}`, leader: null, connected: [], known: [] });
    expect((await worker(`/n/${handle}/health`)).status).toBe(503);

    const laptop = await node(a.relay, "laptop");
    await vi.waitUntil(async () => (await a.relay.nodes()).connected.length === 1);
    const res = await worker(`/n/${handle}/mcp?tools=memory`, { method: "POST", headers: { Authorization: "Bearer xyz", "Content-Type": "application/json", Cookie: "c=1" }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-node")).toBe("laptop");
    const got = (await res.json()) as { path: string; method: string; headers: Record<string, string>; body: string };
    expect(got).toMatchObject({ method: "POST", path: "/mcp?tools=memory", body: '{"a":1}' });
    expect(got.headers.authorization).toBe("Bearer xyz");
    expect(got.headers.host).toBeUndefined();
    expect(got.headers.cookie).toBeUndefined();
    // RFC 8414's path-suffixed metadata, as the node's own.
    expect(((await (await worker(`/.well-known/oauth-authorization-server/n/${handle}`)).json()) as { path: string }).path).toBe("/.well-known/oauth-authorization-server");
    expect(((await (await worker(`/.well-known/oauth-protected-resource/n/${handle}/mcp`)).json()) as { path: string }).path).toBe("/.well-known/oauth-protected-resource/mcp");

    // The newest, until a leader is chosen.
    const phoneWs = await node(phoneRelay, "phone");
    await vi.waitUntil(async () => (await a.relay.nodes()).connected.length === 2);
    expect((await a.relay.nodes()).known!.map((k) => [k.device, k.name])).toEqual([[phone.id, "phone"], [a.device.id, "laptop"]]);
    expect((await worker(`/n/${handle}/x`)).headers.get("x-node")).toBe("phone");
    expect((await phoneRelay.setLeader(a.device.id)).leader).toBe(a.device.id);
    expect((await worker(`/n/${handle}/x`)).headers.get("x-node")).toBe("laptop");
    // The leader away: the rest still answer.
    laptop.close();
    await vi.waitUntil(async () => (await a.relay.nodes()).connected.length === 1);
    expect((await worker(`/n/${handle}/x`)).headers.get("x-node")).toBe("phone");
    phoneWs.close();
    await vi.waitUntil(async () => (await a.relay.nodes()).connected.length === 0);
    // Gone, but still known, to be chosen while away.
    expect((await a.relay.nodes()).known!.map((k) => k.name).sort()).toEqual(["laptop", "phone"]);
    expect((await worker(`/n/${handle}/x`)).status).toBe(503);

    // Not a device id, and no sockets without a token.
    await expect(a.relay.setLeader("nope")).rejects.toMatchObject({ status: 400 });
    expect((await worker("/e2ee/nodes/live", { headers: { Upgrade: "websocket" } })).status).toBe(401);
    expect((await worker("/n/short/x")).status).toBe(404);
  });

  it("let a device have one socket: a newer one replaces the old", async () => {
    const a = await account();
    const handle = await nodeHandle(a.keys.id);
    const first = await node(a.relay, "first");
    let closed = 0;
    first.addEventListener("close", (e) => void (closed = e.code));
    await node(a.relay, "second");
    await vi.waitUntil(() => closed === 4000);
    expect((await a.relay.nodes()).connected).toHaveLength(1);
    expect((await worker(`/n/${handle}/x`)).headers.get("x-node")).toBe("second");
  });
});

describe("channels", () => {
  // Relay's socket(), made from the test Worker's fetch: a WebSocket-shaped
  // thing that opens once the upgrade's done.
  function socketVia(): (url: string, protocols: string[]) => WebSocket {
    return (url, protocols) => {
      const t = new EventTarget() as EventTarget & { readyState: number; binaryType: string; send(b: unknown): void; close(code?: number, reason?: string): void; ws?: WebSocket };
      t.readyState = 0;
      t.binaryType = "blob";
      t.send = (b) => t.ws!.send(b as ArrayBuffer);
      t.close = (code, reason) => (t.ws ? t.ws.close(code, reason) : undefined);
      void fetcher(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols.join(", ") } }).then((res) => {
        if (!res.webSocket) {
          t.readyState = 3;
          return t.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: `${res.status}` }));
        }
        const ws = (t.ws = res.webSocket);
        // What the client asked for (wsLink and serveTunnel ask for ArrayBuffers).
        (ws as unknown as { binaryType: string }).binaryType = t.binaryType;
        ws.addEventListener("message", (e) => t.dispatchEvent(Object.assign(new Event("message"), { data: e.data })));
        ws.addEventListener("close", (e) => {
          t.readyState = 3;
          t.dispatchEvent(Object.assign(new Event("close"), { code: e.code, reason: e.reason }));
        });
        ws.accept();
        t.readyState = 1;
        t.dispatchEvent(new Event("open"));
      });
      return t as unknown as WebSocket;
    };
  }

  async function devices() {
    const a = await account();
    const laptop = new Relay({ origin: ORIGIN, fetch: fetcher, device: a.device, cert: a.cert, socket: socketVia() });
    const node = newDevice();
    const nodeRelay = new Relay({ origin: ORIGIN, fetch: fetcher, device: node, cert: certify(a.keys, node, "node"), socket: socketVia() });
    return { a, laptop, node, nodeRelay };
  }

  const serve = (relay: Relay, channels: (req: Request) => Promise<Response>) => {
    const stop = relay.serveTunnel(async () => new Response("tunnel"), { name: "node", channels });
    return stop;
  };

  it("join two of the account's devices through the relay, which passes on only sealed frames", async () => {
    const { a, laptop, node, nodeRelay } = await devices();
    // Not connected yet.
    await expect(laptop.channel(node.id)).rejects.toThrow(/404/);
    const stop = serve(nodeRelay, async (req) => new Response(`${req.method} ${new URL(req.url).pathname}: ${await req.text()}`));
    await vi.waitUntil(async () => (await a.relay.nodes()).connected.length === 1);

    const ch = await laptop.channel(node.id);
    expect(ch.peer.body.name).toBe("node");
    expect(await (await ch.fetch("/api/node/boards", { method: "POST", body: "a secret" })).text()).toBe("POST /api/node/boards: a secret");
    // The tunnel's text answers still work on the same socket.
    expect(await (await worker(`/n/${await nodeHandle(a.keys.id)}/x`)).text()).toBe("tunnel");

    // Without a token, or to something that isn't a device, no channel.
    expect((await worker(`/e2ee/channel?to=${node.id}`, { headers: { Upgrade: "websocket" } })).status).toBe(401);
    const t = await laptop.token();
    expect((await worker("/e2ee/channel?to=nope", { headers: { Upgrade: "websocket", Authorization: `Bearer ${t}` } })).status).toBe(400);

    // Another account's device can't reach this one's.
    const b = await account();
    const theirs = new Relay({ origin: ORIGIN, fetch: fetcher, device: b.device, cert: b.cert, socket: socketVia() });
    await expect(theirs.channel(node.id)).rejects.toThrow(/404/);

    // The node going away ends the channel.
    stop();
    expect(await ch.closed).toMatch(/went away|closed/);
  });

  it("refuse a revoked device's channel at the relay, and at the other end", async () => {
    const { a, laptop, node, nodeRelay } = await devices();
    const stop = serve(nodeRelay, async () => new Response("ok"));
    await vi.waitUntil(async () => (await a.relay.nodes()).connected.length === 1);
    const phone = newDevice();
    const phoneCert = certify(a.keys, phone, "phone");
    const phoneRelay = new Relay({ origin: ORIGIN, fetch: fetcher, device: phone, cert: phoneCert, socket: socketVia() });
    await phoneRelay.token();
    await a.relay.revoke(revoke(a.keys, phone.id));
    // Its token's gone.
    await expect(phoneRelay.channel(node.id)).rejects.toThrow(/refused|401/);
    // A relay that lets it in anyway (here, on the laptop's token): the node
    // goes by the account's revocations, and the phone's hello is its own.
    const sneaky = new Relay({ origin: ORIGIN, fetch: fetcher, device: phone, cert: phoneCert, token: { token: await laptop.token(), expires: Date.now() + 3600_000 }, socket: socketVia() });
    await expect(sneaky.channel(node.id)).rejects.toThrow(/revoked/);
    // The laptop still gets in.
    expect(await (await (await laptop.channel(node.id)).fetch("/")).text()).toBe("ok");
    stop();
  });

  it("carry a stream past the tunnel's 17 MB", async () => {
    const { a, laptop, node, nodeRelay } = await devices();
    const stop = serve(nodeRelay, async (req) => new Response(req.body));
    await vi.waitUntil(async () => (await a.relay.nodes()).connected.length === 1);
    const ch = await laptop.channel(node.id);
    const big = new Uint8Array(18 * 1024 * 1024);
    for (let k = 0; k < big.length; k += 1000) big[k] = k % 251;
    const back = new Uint8Array(await (await ch.fetch("/big", { method: "POST", body: big })).arrayBuffer());
    expect(back.length).toBe(big.length);
    let same = true;
    for (let k = 0; k < big.length; k += 1000) same &&= back[k] === big[k];
    expect(same).toBe(true);
    ch.close();
    stop();
  }, 120_000);

  it("keep a stream open past the tunnel's 60 seconds", async () => {
    const { a, laptop, node, nodeRelay } = await devices();
    let send!: ReadableStreamDefaultController<Uint8Array>;
    const stop = serve(nodeRelay, async () => new Response(new ReadableStream<Uint8Array>({ start: (c) => void (send = c) })));
    await vi.waitUntil(async () => (await a.relay.nodes()).connected.length === 1);
    const ch = await laptop.channel(node.id);
    const rd = (await ch.fetch("/events")).body!.getReader();
    send.enqueue(utf8("first"));
    expect(new TextDecoder().decode((await rd.read()).value)).toBe("first");
    await new Promise((r) => setTimeout(r, 61_000));
    send.enqueue(utf8("a minute later"));
    expect(new TextDecoder().decode((await rd.read()).value)).toBe("a minute later");
    ch.close();
    stop();
  }, 90_000);
});
