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
  type WireOp,
  Relay,
  Replica,
  accountKeys,
  answer,
  approve,
  b64url,
  certify,
  creation,
  newDevice,
  newRoot,
  objectId,
  objectKey,
  openBlob,
  pairNew,
  revoke,
  sealBlob,
  utf8,
} from "../../lib/e2ee";
import { ORIGIN, invitedToken, ownerToken, worker } from "./login";

// The relay for end-to-end encrypted accounts (e2ee.ts, log.ts,
// mailbox.ts), driven by the clients' own library (lib/e2ee), as the bridge
// and the page drive it.

const env = bindings as unknown as Env;
const fetcher = (input: string, init?: RequestInit) => exports.default.fetch(new Request(input, init));

let admin: string;
beforeEach(async () => {
  admin = await ownerToken();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function invite(uses = 1) {
  const res = await worker("/api/admin/invites", {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "e2ee", uses }),
  });
  return (await res.json<{ code: string }>()).code;
}

type Account = { root: Uint8Array; keys: AccountKeys; device: Device; cert: Signed<DeviceCert>; relay: Relay };

// An account with its first device, signed up through the relay.
async function account(code?: string | null, opts: { bearer?: string } = {}): Promise<Account> {
  const root = newRoot();
  const keys = accountKeys(root);
  const device = newDevice();
  const cert = certify(keys, device, "laptop");
  const relay = new Relay({ origin: ORIGIN, fetch: fetcher, device, cert });
  await relay.createAccount(creation(keys, ORIGIN, code === undefined ? await invite() : code), cert, opts.bearer);
  return { root, keys, device, cert, relay };
}

const post = (path: string, body: unknown, token?: string) =>
  worker(path, { method: "POST", headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });

describe("accounts", () => {
  it("are made with an invite, once, and refused without one", async () => {
    const a = await account();
    expect(await a.relay.token()).toMatch(/^cbe_/);
    await expect(account(null)).rejects.toThrow(/invite is needed/);
    const code = await invite();
    await account(code);
    await expect(account(code)).rejects.toThrow(/used/);
    // The same account twice.
    await expect(a.relay.createAccount(creation(a.keys, ORIGIN, await invite()), a.cert)).rejects.toThrow(/already exists/);
  });

  it("are made by an admin with no invite, and not by anyone else", async () => {
    const a = await account(null, { bearer: admin });
    expect(await a.relay.token()).toMatch(/^cbe_/);
    const you = await invitedToken(admin);
    await expect(account(null, { bearer: you })).rejects.toThrow(/for admins/);
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
    // A Google token isn't one of these.
    expect((await worker("/e2ee/revoked", { headers: { Authorization: `Bearer ${admin}` } })).status).toBe(401);
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
    await expect(a.relay.append(object, [{ ...ok, ciphertext: b64url(new Uint8Array(64 * 1024 + 1)) }])).rejects.toThrow(/at most/);
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
    ws.addEventListener("message", (e) => got.push(...JSON.parse(e.data as string).ops));
    ws.accept();
    await rep.change({ t: "card", card: "task-1", set: { status: "doing" } });
    await rep.push();
    await vi.waitUntil(() => got.length === 2);
    expect(got.map((o) => o.pos)).toEqual([1, 2]);
    // Another device follows along from what it got.
    const other = await Replica.open({ transport: a.relay, key, object, device: "elsewhere" });
    other.receive(got);
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

describe("alongside the plaintext API", () => {
  it("leaves Google sign-in and the boards as they were", async () => {
    await account();
    const res = await worker("/api/boards", { headers: { Authorization: `Bearer ${admin}` } });
    expect(res.status).toBe(200);
    const me = await (await worker("/api/me", { headers: { Authorization: `Bearer ${admin}` } })).json<any>();
    expect(me.email).toBe("me@example.com");
  });
});
