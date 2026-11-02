// Test vectors for the Android app's e2ee (app.corkboard.e2ee), made by
// lib/e2ee itself, so the Kotlin is checked byte for byte against what the
// bridge, the page and the Worker do. Randomness is a seeded stream, so
// running this again writes the same file.
//
//   bun android/e2ee-vectors.ts
//
// writes android/app/src/test/resources/e2ee-vectors.json, which
// E2eeVectorsTest reads.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Before lib/e2ee is loaded: every random byte from here on is the seed's.
let counter = 0;
const SEED = new TextEncoder().encode("corkboard android vectors");
(globalThis.crypto as { getRandomValues: unknown }).getRandomValues = <T extends ArrayBufferView>(a: T): T => {
  const out = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let at = 0; at < out.length; at += 32) {
    const block = sha256(new Uint8Array([...SEED, ...new Uint8Array(new Uint32Array([counter++]).buffer)]));
    out.set(block.subarray(0, Math.min(32, out.length - at)), at);
  }
  return a;
};

const e = await import("../lib/e2ee/index");
const { b64url, fromB64url, utf8, fromUtf8, signed, canonical } = e;

const hex = bytesToHex;
const b64 = (b: Uint8Array) => b64url(b);
const text = (b: Uint8Array) => fromUtf8(b);

const root = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const account = e.accountKeys(root);

const { grantBytes, rotationBytes, snapshotLabel } = e;
const objectLabel = (kind: string, name: string) => `${kind}\0${name}`;

const { ed25519 } = await import("@noble/curves/ed25519.js");
const signWith = (seed: Uint8Array, bytes: Uint8Array) => b64(ed25519.sign(bytes, seed));

const device = e.newDevice();
const other = e.newDevice();

// Merging: ops as several devices make them, as sync.test.ts's history does.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const FIELDS = ["title", "status", "priority", "labels", "body", "10", "2"];
const VALUES: Record<string, unknown[]> = {
  title: ["a", "b", "c \"quoted\""],
  status: ["backlog", "doing", "done"],
  priority: ["high", "low", null],
  labels: [[], ["x"], ["x", "y"]],
  body: ["", "one", "two\nlines\ttab\u0001"],
  "10": [1, 2.5, true],
  "2": [{ a: 1 }, "z", false],
};
function history(r: () => number, n: number) {
  const devices = ["dA", "dB", "dC"];
  const clocks: Record<string, number> = { dA: 0, dB: 0, dC: 0 };
  const out: { id: string; op: unknown }[] = [];
  for (let i = 0; i < n; i++) {
    const dev = devices[Math.floor(r() * 3)];
    if (r() < 0.5) clocks[dev] = Math.max(...Object.values(clocks));
    const clock = ++clocks[dev];
    const card = `task-${1 + Math.floor(r() * 4)}`;
    let change: unknown;
    const roll = r();
    if (roll < 0.3) change = { t: "log", card, entry: { at: `t${i}`, who: dev, note: `note ${i}` } };
    else if (roll < 0.33) change = { t: "mystery", card };
    else {
      const set: Record<string, unknown> = {};
      for (const f of FIELDS) if (r() < 0.4) set[f] = VALUES[f][Math.floor(r() * 3)];
      if (r() < 0.05) set.id = "ignored";
      change = { t: "card", card, set };
    }
    out.push({ id: `op-${i.toString().padStart(4, "0")}-${Math.floor(r() * 1e6)}`, op: { v: 1, clock, device: dev, change } });
  }
  return out;
}
const merges = [3, 17, 99].map((seed) => {
  const ops = history(rng(seed), 60);
  const s = e.empty();
  for (const { id, op } of ops) e.apply(s, id, op as never);
  return { ops, cards: JSON.stringify(e.cards(s)), clock: s.clock };
});

// A log as the relay would serve it, sealed by a TS replica.
const boardKey = e.objectKey(root, "board", "home");
const boardId = e.objectId(root, "board", "home");
const served: unknown[] = [];
const transport = {
  append: async (_o: string, ops: { id: string; seq: number; nonce: string; ciphertext: string }[]) =>
    ops.map((o) => {
      const pos = served.length + 1;
      served.push({ ...o, device: device.id, pos, ts: "2026-11-02T00:00:00.000Z" });
      return { id: o.id, pos };
    }),
  read: async (_o: string, since: number) => ({ ops: served.filter((w) => (w as { pos: number }).pos > since), head: served.length }),
};
const rep = await e.Replica.open({ transport, key: boardKey, object: boardId, device: device.id });
await rep.change(
  { t: "card", card: "task-1", set: { title: "Buy milk", status: "backlog", priority: "high" } },
  { t: "card", card: "task-2", set: { title: "Ship it", status: "doing" } },
  { t: "log", card: "task-1", entry: { at: "2026-11-02T10:00:00Z", who: "matthew", note: "asked" } },
  { t: "card", card: "task-1", set: { status: "done" } },
);
await rep.push();
// One that's tampered with, one claimed by another device: both rejected.
const bad = structuredClone(served[1]) as { id: string; pos: number; ciphertext: string };
bad.id = "tampered-op-aaaaaaaa";
bad.pos = served.length + 1;
served.push(bad);
const liar = structuredClone(served[0]) as { pos: number; device: string };
liar.pos = served.length + 1;
liar.device = other.id;
served.push(liar);
await rep.pull();
const replica = { key: hex(boardKey), object: boardId, device: device.id, ops: served, cards: JSON.stringify(rep.cards()), rejected: [...rep.rejected] };

// A snapshot of that state at its head, as an owner's client seals it.
const upTo = served.length;
const snapSealed = e.sealRecord(boardKey, boardId, snapshotLabel(0, upTo), rep.state);
const snapshot = { upTo, epoch: 0, nonce: b64(snapSealed.nonce), ciphertext: b64(snapSealed.ciphertext), cards: JSON.stringify(rep.cards()) };

// Records, blobs and sealed boxes.
const recordBody = { v: 1, clock: 3, device: device.id, change: { t: "card", card: "x", set: { title: "héllo ✓" } } };
const rec = e.sealRecord(boardKey, boardId, "op-id-0123456789ab", recordBody);
const blobKey = e.random(32);
const blobBytes = utf8("an attachment's bytes, ".repeat(10));
const blob = e.sealBlob(blobKey, "blob-id-0123456789ab", blobBytes);
const recipient = e.boxPair(e.random(32));
const boxed = e.sealTo(recipient.public, utf8("a board key, wrapped"));

// Certificates and the statements around them.
const cert = e.certify(account, device, "phone", 1762077600000);
const revocation = e.revoke(account, other.id, 1762077600001);
const creation = e.creation(account, "https://portal.corkboard.fyi", null);
const creationInvite = e.creation(account, "https://portal.corkboard.fyi", "inv_abc");
const challenge = e.answer(device, { origin: "https://portal.corkboard.fyi", nonce: "bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2Utbm9uY2Utbm8", account: account.id });

// Pairing: an approver's ephemeral key, the transcript, and a delivery.
const approver = e.boxPair(e.random(32));
const t = { v: 1 as const, code: "ABCDE12345", approver: b64(approver.public), box: b64(device.box.public), device: device.id };
const delivery = e.deliver(approver, t, root, cert);

// Sharing: a member's account, a grant and the key sealed to them.
const memberRoot = hexToBytes("1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100");
const member = e.accountKeys(memberRoot);
const brainId = b64(e.random(16));
const brainKey = e.random(32);
const sharedKey = { v: 1, owner: account.id, object: brainId, kind: "brain", name: "pepper", epoch: 1, key: b64(brainKey) };
const sealedKey = e.sealTo(member.box.public, utf8(JSON.stringify(sharedKey)));
const grant = { v: 1, owner: account.id, object: brainId, member: member.id, role: "read", epoch: 1, wrapped: b64(sha256(sealedKey)), at: 1762077600002 };
const newRoot = hexToBytes("aa".repeat(32));
const rotated = e.accountKeys(newRoot);
const rotation = { v: 1, account: account.id, from: account.id, to: rotated.id, box: b64(rotated.box.public), at: 1762077600004 };
// A brain's notes and entries as records, under its shared key.
const brainRep = await e.Replica.open({
  transport: {
    append: async (_o: string, ops: { id: string }[]) => ops.map((o, i) => ({ id: o.id, pos: i + 1 })),
    read: async () => ({ ops: [], head: 0 }),
  },
  key: brainKey,
  object: brainId,
  device: other.id,
});
await brainRep.change(
  { t: "card", card: "brain", set: { title: "Pepper", description: "the day planner" } },
  { t: "card", card: "note:goals", set: { title: "Goals", kind: "note", body: "ship the phone app" } },
  { t: "card", card: "entry:1", set: { at: "2026-11-02T09:00:00Z", day: "2026-11-02", who: "pepper", text: "planned the day" } },
);
const brainOps = (await (brainRep as unknown as { s: { outbox: { id: string; seq: number; nonce: string; ciphertext: string }[] } }).s.outbox).map((o, i) => ({
  ...o,
  epoch: 1,
  device: other.id,
  pos: i + 1,
  ts: "2026-11-02T00:00:00.000Z",
}));

const flat = (o: Record<string, unknown>) => o as Record<string, string | number | null>;

const vectors = {
  root: hex(root),
  account: { signSeed: hex(account.sign.secret), id: account.id, boxSecret: hex(account.box.secret), box: b64(account.box.public) },
  derive: [
    { label: "account sign", length: 32 },
    { label: "account box", length: 32 },
    { label: "object id board\0home", length: 16 },
    { label: "anything at all", length: 64 },
  ].map((d) => ({ ...d, out: hex(e.derive(root, d.label, d.length)) })),
  objects: [
    ["board", "home"],
    ["board", "a/b é ✓"],
    ["brain", "pepper"],
    ["memory", ""],
    ["index", ""],
  ].map(([kind, name]) => ({
    kind,
    name,
    key: hex(e.derive(root, `object key ${objectLabel(kind, name)}`)),
    id: b64(e.derive(root, `object id ${objectLabel(kind, name)}`, 16)),
  })),
  b64: [[], [0], [255, 254], [251, 255], [1, 2, 3, 4, 5]].map((b) => ({ hex: hex(new Uint8Array(b)), b64: b64(new Uint8Array(b)) })),
  canonical: [
    { b: 1, a: "x", c: null },
    { name: "phöne \"one\"\n\t\u0001\u001f  ✓ 😀", n: 9007199254740991, neg: -5, z: 0 },
    { B: "upper", a: "lower", _: "under", "10": "ten", "9": "nine" },
  ].map((o) => ({ object: o, text: canonical(flat(o)) })),
  device: { signSeed: hex(device.sign.secret), boxSecret: hex(device.box.secret), id: device.id, box: b64(device.box.public) },
  cert: { ...cert, bytes: text(e.certBytes(cert.body)) },
  revocation: { ...revocation, bytes: text(e.revocationBytes(revocation.body)) },
  creation: { ...creation, bytes: text(e.creationBytes(creation.body)) },
  creationInvite: { ...creationInvite, bytes: text(e.creationBytes(creationInvite.body)) },
  challenge: { ...challenge, bytes: text(e.challengeBytes(challenge.body)) },
  pairing: {
    approverSecret: hex(approver.secret),
    transcript: t,
    transcriptBytes: text(e.transcriptBytes(t)),
    commitBytes: text(e.commitBytes(t.approver)),
    commitment: e.commitment(t.approver),
    sas: e.sas(t),
    more: ["0000000000", "ZZZZZZZZZZ", "ABCDE12345"].map((code) => ({ t: { ...t, code }, sas: e.sas({ ...t, code }) })),
    delivery,
    qr: e.qrPayload(t.code, device),
  },
  codes: ["abcde-12345", " ABCDE 12345 ", "oiloi-loilo", "ABCDE1234", "ABCDU12345", "abcde-123456"].map((s) => ({ in: s, out: e.normalizeCode(s) ?? null })),
  record: { key: hex(boardKey), object: boardId, op: "op-id-0123456789ab", body: JSON.stringify(recordBody), nonce: b64(rec.nonce), ciphertext: b64(rec.ciphertext), aad: text(e.aad(boardId, "op-id-0123456789ab")) },
  blob: { key: hex(blobKey), id: "blob-id-0123456789ab", bytes: hex(blobBytes), sealed: hex(blob) },
  box: { secret: hex(recipient.secret), public: hex(recipient.public), message: "a board key, wrapped", sealed: hex(boxed) },
  libsodiumBox: {
    pk: "020380a533840954745c5d850e98456db8192edbd866d2df3b0aef5e083c5a19",
    sk: "9ba6694f505f9da3e742caa7857f33164fd0f4e97ba1bc4a20f9858cc2702b09",
    c: "30380907de9146600cd038a806e5cdb84e6e62521c3b8730cc5f003368f59d0aa5c0c708c8589412616796a408a2b893307abda135021afea2a9d9794c573ea6b9c863ce762449bb7c26fd",
    message: "corkboard sealed box vector",
  },
  phrase: [root, memberRoot, newRoot, hexToBytes("ff".repeat(32))].map((r) => ({ root: hex(r), phrase: e.toPhrase(r) })),
  merge: merges,
  replica,
  snapshot,
  sharing: {
    memberRoot: hex(memberRoot),
    member: { id: member.id, box: b64(member.box.public) },
    sharedKey,
    sealedKey: b64(sealedKey),
    grant: { body: grant, bytes: text(grantBytes(grant)), sig: signWith(account.sign.secret, grantBytes(grant)) },
    brain: { object: brainId, key: hex(brainKey), epoch: 1, ops: brainOps },
  },
  rotation: {
    newRoot: hex(newRoot),
    body: rotation,
    bytes: text(rotationBytes(rotation)),
    sig: signWith(account.sign.secret, rotationBytes(rotation)),
    sealedRoot: b64(e.sealTo(device.box.public, newRoot)),
    cert: e.certify(rotated, device, "phone", 1762077600005),
  },
  snapshotLabel: snapshotLabel(2, 41),
};

// What the Kotlin can't check but by these: they round-trip here first.
if (text(fromB64url(b64(utf8("x")))) !== "x") throw new Error("b64url");

const out = join(dirname(new URL(import.meta.url).pathname), "app/src/test/resources/e2ee-vectors.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${out}`);
