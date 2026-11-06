// What the relay and its clients agree on, byte for byte, with no crypto
// library in it: the Worker (relay/src/routes.ts) imports this alone and
// checks signatures with WebCrypto, so it carries none of @noble.
//
// Everything signed is a domain-separated line and the canonical JSON of a
// flat object of strings and integers: keys sorted, no spaces. Keys, nonces
// and ciphertext travel as unpadded base64url.

export const VERSION = "corkboard-e2ee/v1";

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

export function b64url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}

// A 32-byte key as base64url is 43 characters.
export const KEY = /^[A-Za-z0-9_-]{43}$/;
// What a client names an op, a blob or a log by: opaque, so the relay
// learns nothing from it (keys.ts derives a board's from its key).
export const OPAQUE = /^[A-Za-z0-9_-]{16,64}$/;

type Flat = Record<string, string | number | null>;

export function canonical(o: Flat): string {
  const keys = Object.keys(o).sort();
  for (const k of keys) {
    const v = o[k];
    if (v !== null && typeof v !== "string" && !(typeof v === "number" && Number.isSafeInteger(v))) throw new Error(`${k}: only strings, integers and null are signed`);
  }
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(",")}}`;
}

// The bytes a signature covers: what it is, then the statement.
export const signed = (kind: string, o: Flat) => utf8(`${VERSION} ${kind}\n${canonical(o)}`);

// A device certificate: the account's signing key vouches for a device's
// signing key (and its box key, for what's wrapped to it).
export type DeviceCert = { v: 1; account: string; device: string; box: string; name: string; issued: number };
export type Signed<T> = { body: T; sig: string };

// The account's word that a device is no longer one of its own.
export type Revocation = { v: 1; account: string; device: string; at: number };

// Account creation: proof the creator holds the account key, tied to this
// relay and the invite it's spending.
export type Creation = { v: 1; origin: string; account: string; box: string; invite: string | null };

// Sign-in: the relay's nonce, signed by a device with a cert.
export type Challenge = { v: 1; origin: string; nonce: string; account: string; device: string };

export function isCert(c: unknown): c is DeviceCert {
  const o = c as DeviceCert;
  return !!o && o.v === 1 && KEY.test(o.account) && KEY.test(o.device) && KEY.test(o.box) && typeof o.name === "string" && o.name.length <= 100 && Number.isSafeInteger(o.issued);
}

export function isRevocation(r: unknown): r is Revocation {
  const o = r as Revocation;
  return !!o && o.v === 1 && KEY.test(o.account) && KEY.test(o.device) && Number.isSafeInteger(o.at);
}

export const certBytes = (c: DeviceCert) => signed("device-cert", c);
export const revocationBytes = (r: Revocation) => signed("revocation", r);
export const creationBytes = (c: Creation) => signed("create-account", c);
export const challengeBytes = (c: Challenge) => signed("challenge", c);

// Pairing (pairing.ts): the approver commits to its key before it sees the
// new device's, and the short code both show is a hash of the whole
// exchange, so a relay in the middle has one guess in a million.
export const commitBytes = (approver: string) => signed("pair-commit", { approver });
export type PairTranscript = { v: 1; code: string; approver: string; box: string; device: string };
export const transcriptBytes = (t: PairTranscript) => signed("pair-transcript", t);

// A pairing code: ten characters of Crockford's base32 (50 bits), shown as
// XXXXX-XXXXX; what's typed is forgiven case, dashes, O for 0 and I/L for 1.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function normalizeCode(s: string): string | undefined {
  const c = s.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(c) ? c : undefined;
}
export const showCode = (c: string) => `${c.slice(0, 5)}-${c.slice(5)}`;

// An op as the relay keeps and serves it. seq is the device's own count, so
// a reader can tell when a device's ops are missing; pos is the relay's
// order, which is what `since` counts in.
// epoch: which of the object's keys sealed it (absent, 0).
export type WireOp = { id: string; device: string; seq: number; pos: number; epoch?: number; nonce: string; ciphertext: string; ts: string };
export type NewOp = { id: string; seq: number; epoch?: number; nonce: string; ciphertext: string };

// A log's merged state up to pos upTo, which the ops at or before it are
// replaced by. Only the owner makes one.
export type Snapshot = { upTo: number; epoch: number; nonce: string; ciphertext: string };
export type LogRead = { ops: WireOp[]; head: number; epoch: number; count: number; bytes: number; snapshot?: Snapshot };

// Sharing: the owner's word that a member may read (or write) an object,
// and the hash of the sealed box carrying its key to them, since a sealed
// box says nothing of who sealed it.
export type Role = "read" | "write";
export type Grant = { v: 1; owner: string; object: string; member: string; role: Role; epoch: number; wrapped: string; at: number };
// The account's key changing: signed by the key before it. account is the
// account's id (its first key), which never changes.
export type Rotation = { v: 1; account: string; from: string; to: string; box: string; at: number };

export const ROLES: Role[] = ["read", "write"];

export function isGrant(g: unknown): g is Grant {
  const o = g as Grant;
  return (
    !!o && o.v === 1 && KEY.test(o.owner) && OPAQUE.test(o.object) && KEY.test(o.member) && ROLES.includes(o.role) && Number.isSafeInteger(o.epoch) && o.epoch >= 0 && KEY.test(o.wrapped) && Number.isSafeInteger(o.at)
  );
}
export function isRotation(r: unknown): r is Rotation {
  const o = r as Rotation;
  return !!o && o.v === 1 && KEY.test(o.account) && KEY.test(o.from) && KEY.test(o.to) && KEY.test(o.box) && o.from !== o.to && Number.isSafeInteger(o.at);
}

export const grantBytes = (g: Grant) => signed("grant", g);
export const rotationBytes = (r: Rotation) => signed("rotation", r);

// An account as the relay shows it to anyone: its id, its key and box key
// now, and the signed statements that get from the id to them.
export type AccountView = { id: string; key: string; box: string; proof: { creation: Signed<Creation>; rotations: Signed<Rotation>[] } };

// What a device whose cert stopped counting gets after a rotation: the
// account's rotations, its new cert, and the new root sealed to its box key.
export type Rotated = { rotations: Signed<Rotation>[]; cert: Signed<DeviceCert>; root: string };

// Limits the relay holds clients to (relay/src/log.ts).
export const LIMITS = {
  // One op's ciphertext.
  op: 256 * 1024,
  // One push.
  batch: 100,
  batchBytes: 1024 * 1024,
  // A whole log.
  log: 64 * 1024 * 1024,
  // One read.
  read: 500,
  // An encrypted attachment.
  blob: 25 * 1024 * 1024,
  // A snapshot's ciphertext.
  snapshot: 16 * 1024 * 1024,
  // When a log is worth compacting: ops, or bytes, kept since its snapshot.
  compactOps: 2000,
  compactBytes: 8 * 1024 * 1024,
  // Members of one object.
  members: 100,
  // A request's or answer's body through the tunnel (an episode's transcript is 16 MB).
  tunnel: 17 * 1024 * 1024,
  // How long the relay waits for a node's answer.
  tunnelMs: 60_000,
  // One message on a channel (channel.ts's FRAME of body, sealed and framed, with room).
  channelMessage: 80 * 1024,
};

// The account's nodes (relay/src/nodes.ts): the devices with a socket open
// to the relay, and the one the user chose to lead, where the always-on
// work happens (.agent/plans/local-memory.md, step 8).
// known: every device that has connected, by the name its cert gives, and
// when it last came or went (an older relay leaves it out).
export type NodesView = { leader: string | null; connected: { device: string; since: number }[]; known?: { device: string; name: string; seen: number }[] };

// The tunnel: a request to <relay>/n/<handle>/…, sent as this to a node
// over its socket, and the node's answer. Bodies are base64url; headers
// are pairs, so a repeated one survives.
export type TunnelRequest = { id: string; method: string; path: string; headers: [string, string][]; body?: string };
export type TunnelResponse = { id: string; status: number; headers: [string, string][]; body?: string };

// Channels (lib/e2ee/channel.ts): GET /e2ee/channel?to=<device> is a
// socket of the opener's own, carrying the channel's messages as they are.
// The relay passes them on over the device's node socket as binary
// messages, kind (1) || channel id (CHANNEL_ID) || payload: open's payload
// is { from } as JSON (the opener, in the relay's word; the handshake is
// what to go by), a message's is the message, close's the reason. The
// device sends message and close back the same way.
export const CHANNEL = { open: 0, message: 1, close: 2 } as const;
export const CHANNEL_ID = 16;

// Where an account's nodes are reached: <relay>/n/<handle>. A hash of the
// account id, so it's short and says nothing a URL shouldn't.
export async function nodeHandle(account: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(account)))).slice(0, 22);
}
export const HANDLE = /^[A-Za-z0-9_-]{22}$/;
