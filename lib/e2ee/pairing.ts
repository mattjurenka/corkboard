// A new device joins the account by getting the root from one that has it,
// through a mailbox on the relay (cloud/src/mailbox.ts) that lasts ten
// minutes and is gone once the root has been read.
//
//   new device                      relay                      approving device
//   create ─────────────────────▶ code, secret
//   shows the code (and a QR of code + its box key)
//                                                ◀──── commit = H(approver key)
//   sees the commit; join ──────▶ box key, device key
//                                                ────▶ sees them; reveal approver key
//   checks it against the commit
//   both show sas(transcript); the person checks they match, on both
//                                                ◀──── deliver: root + the new device's cert
//   reads it; the mailbox is deleted
//
// Each side's random key is shown only after the other side's is fixed (the
// approver's by its commitment, the new device's by its waiting for that
// commitment before joining), so a relay in the middle that swaps keys
// can't steer both short codes to match: its one try is 1 in 10^6, and a
// mismatch ends the pairing. Scanning the QR checks the new device's key
// outright on the approving side.
//
// The root goes in a record (record.ts) under a key from X25519 between
// the approver's key and the new device's box key, with the transcript as
// salt and associated data: only those two could have made it, so a relay
// can't hand the new device a root of its own choosing either.

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { certify, type Device } from "./device";
import { accountKeys, boxPair, type KeyPair, random } from "./keys";
import { open, seal } from "./record";
import {
  type DeviceCert,
  type PairTranscript,
  type Signed,
  b64url,
  commitBytes,
  fromB64url,
  fromUtf8,
  normalizeCode,
  transcriptBytes,
  utf8,
} from "./wire";

export const commitment = (approver: string) => b64url(sha256(commitBytes(approver)));

// Six digits, from the whole transcript.
export function sas(t: PairTranscript): string {
  const h = sha256(transcriptBytes(t));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

function channel(secret: Uint8Array, pub: Uint8Array, t: PairTranscript): Uint8Array {
  const shared = x25519.getSharedSecret(secret, pub);
  return hkdf(sha256, shared, sha256(transcriptBytes(t)), utf8("pair deliver"), 32);
}

export type Delivery = { nonce: string; ciphertext: string };
export type Payload = { root: string; cert: Signed<DeviceCert> };

export function deliver(approver: KeyPair, t: PairTranscript, root: Uint8Array, cert: Signed<DeviceCert>): Delivery {
  const s = seal(channel(approver.secret, fromB64url(t.box), t), utf8(JSON.stringify({ root: b64url(root), cert } satisfies Payload)), transcriptBytes(t));
  return { nonce: b64url(s.nonce), ciphertext: b64url(s.ciphertext) };
}

export function receive(device: Device, t: PairTranscript, d: Delivery): { root: Uint8Array; cert: Signed<DeviceCert> } {
  const plain = open(channel(device.box.secret, fromB64url(t.approver), t), { nonce: fromB64url(d.nonce), ciphertext: fromB64url(d.ciphertext) }, transcriptBytes(t), "pairing delivery");
  const p = JSON.parse(fromUtf8(plain)) as Payload;
  const root = fromB64url(p.root);
  // What came is only good if it is this device's, under that root's account.
  const account = accountKeys(root);
  if (p.cert?.body?.account !== account.id || p.cert.body.device !== device.id || p.cert.body.box !== t.box) throw new Error("pairing delivery: the certificate isn't for this device");
  return { root, cert: p.cert };
}

// QR codes carry the box key too, so a scan needs no short code compared on the approving side.
export const qrPayload = (code: string, device: Device) => `corkboard-pair:1:${code}:${b64url(device.box.public)}`;
export function parseQr(s: string): { code: string; box: string } | undefined {
  const m = s.trim().match(/^corkboard-pair:1:([0-9A-Z]{10}):([A-Za-z0-9_-]{43})$/);
  return m ? { code: m[1], box: m[2] } : undefined;
}

// The mailbox as each side sees it (GET /e2ee/pair/:code).
export type MailboxView = {
  code: string;
  expires: number;
  commit?: string;
  join?: { box: string; device: string; name: string };
  reveal?: string;
  deliver?: Delivery;
};

// What the two drivers below need from the relay (relay.ts has it).
export type PairTransport = {
  create(): Promise<{ code: string; secret: string; expires: number }>;
  view(code: string, secret?: string): Promise<MailboxView>;
  commit(code: string, commit: string): Promise<void>;
  join(code: string, secret: string, j: { box: string; device: string; name: string }): Promise<void>;
  reveal(code: string, approver: string): Promise<void>;
  deliver(code: string, d: Delivery): Promise<void>;
  cancel(code: string, secret?: string): Promise<void>;
};

export type Wait = { interval?: number; until?: number; sleep?: (ms: number) => Promise<void> };
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function poll<T>(get: () => Promise<T | undefined>, w: Wait, expires: number): Promise<T> {
  const until = Math.min(w.until ?? Infinity, expires);
  for (;;) {
    const got = await get();
    if (got !== undefined) return got;
    if (Date.now() >= until) throw new Error("pairing timed out");
    await (w.sleep ?? nap)(w.interval ?? 1000);
  }
}

// The new device's half. show: the code to type (and the QR); confirm: the
// person says the six digits match what the other device shows.
export async function pairNew(
  relay: PairTransport,
  device: Device,
  name: string,
  ui: { show(code: string, qr: string): void; confirm(sas: string): Promise<boolean> },
  w: Wait = {},
): Promise<{ root: Uint8Array; cert: Signed<DeviceCert> }> {
  const { code, secret, expires } = await relay.create();
  ui.show(code, qrPayload(code, device));
  try {
    const commit = await poll(async () => (await relay.view(code, secret)).commit, w, expires);
    const join = { box: b64url(device.box.public), device: device.id, name };
    await relay.join(code, secret, join);
    const approver = await poll(async () => (await relay.view(code, secret)).reveal, w, expires);
    if (commitment(approver) !== commit) throw new Error("pairing: the approving device's key doesn't match what it committed to; someone is in the middle");
    const t: PairTranscript = { v: 1, code, approver, box: join.box, device: join.device };
    if (!(await ui.confirm(sas(t)))) throw new Error("pairing: the codes didn't match");
    const d = await poll(async () => (await relay.view(code, secret)).deliver, w, expires);
    return receive(device, t, d);
  } catch (e) {
    await relay.cancel(code, secret).catch(() => {});
    throw e;
  }
}

// The approving device's half, holding the root. box: the new device's
// box key from its QR, when scanned, checked against the one that joined.
// The six digits are still shown, for the new device's side of the check.
export async function approve(
  relay: PairTransport,
  root: Uint8Array,
  code: string,
  ui: { confirm(sas: string, join: { name: string; device: string }): Promise<boolean> },
  w: Wait & { box?: string } = {},
): Promise<Signed<DeviceCert>> {
  // As typed: the transcript has the code as the relay made it.
  code = normalizeCode(code) ?? code;
  const me = boxPair(random(32));
  const approver = b64url(me.public);
  try {
    await relay.commit(code, commitment(approver));
    const { expires } = await relay.view(code);
    const join = await poll(async () => (await relay.view(code)).join, w, expires);
    if (w.box && join.box !== w.box) throw new Error("pairing: the device that joined isn't the one whose code was scanned; someone is in the middle");
    await relay.reveal(code, approver);
    const t: PairTranscript = { v: 1, code, approver, box: join.box, device: join.device };
    if (!(await ui.confirm(sas(t), join))) throw new Error("pairing: the codes didn't match");
    const cert = certify(accountKeys(root), { id: join.device, box: fromB64url(join.box) }, join.name);
    await relay.deliver(code, deliver(me, t, root, cert));
    return cert;
  } catch (e) {
    await relay.cancel(code).catch(() => {});
    throw e;
  } finally {
    me.secret.fill(0);
  }
}
