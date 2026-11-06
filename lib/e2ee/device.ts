// Devices: each has its own Ed25519 key (what it signs in with) and X25519
// key (what's wrapped to it), made on it and never derived from the root.
// The account's signing key signs a certificate for each, and the relay
// lets in a device whose certificate chains to the account and isn't
// revoked. A revocation is the account key's signed word too, so anyone
// can check a relay's list.

import { ed25519 } from "@noble/curves/ed25519.js";
import { type AccountKeys, type KeyPair, boxPair, random, signPair } from "./keys";
import {
  type Challenge,
  type Creation,
  type DeviceCert,
  type Grant,
  type Revocation,
  type Rotation,
  type Signed,
  b64url,
  certBytes,
  challengeBytes,
  creationBytes,
  fromB64url,
  isCert,
  isRevocation,
  grantBytes,
  revocationBytes,
  rotationBytes,
} from "./wire";

export type Device = { id: string; sign: KeyPair; box: KeyPair };

export function newDevice(): Device {
  return fromSecrets(random(32), random(32));
}

export function fromSecrets(sign: Uint8Array, box: Uint8Array): Device {
  const s = signPair(sign);
  return { id: b64url(s.public), sign: s, box: boxPair(box) };
}

const sign = (kp: KeyPair, bytes: Uint8Array) => b64url(ed25519.sign(bytes, kp.secret));

export function verify(pub: string, bytes: Uint8Array, sig: string): boolean {
  try {
    return ed25519.verify(fromB64url(sig), bytes, fromB64url(pub));
  } catch {
    return false;
  }
}

export function certify(account: AccountKeys, device: { id: string; box: KeyPair | Uint8Array }, name: string, issued = Date.now(), role?: "relay"): Signed<DeviceCert> {
  const box = device.box instanceof Uint8Array ? device.box : device.box.public;
  const body: DeviceCert = { v: 1, account: account.id, device: device.id, box: b64url(box), name: name.slice(0, 100), issued, ...(role && { role }) };
  return { body, sig: sign(account.sign, certBytes(body)) };
}

export function revoke(account: AccountKeys, device: string, at = Date.now()): Signed<Revocation> {
  const body: Revocation = { v: 1, account: account.id, device, at };
  return { body, sig: sign(account.sign, revocationBytes(body)) };
}

export function creation(account: AccountKeys, origin: string, invite: string | null): Signed<Creation> {
  const body: Creation = { v: 1, origin, account: account.id, box: b64url(account.box.public), invite };
  return { body, sig: sign(account.sign, creationBytes(body)) };
}

export function answer(device: Device, c: Omit<Challenge, "v" | "device">): Signed<Challenge> {
  const body: Challenge = { v: 1, ...c, device: device.id };
  return { body, sig: sign(device.sign, challengeBytes(body)) };
}

// Why a device isn't one of the account's, or null if it is.
export function checkCert(account: string, cert: Signed<DeviceCert>, revoked: Iterable<Signed<Revocation>> = []): string | null {
  if (!isCert(cert?.body) || typeof cert.sig !== "string") return "not a device certificate";
  if (cert.body.account !== account) return "certificate is for another account";
  if (!verify(account, certBytes(cert.body), cert.sig)) return "certificate isn't signed by the account";
  for (const r of revoked) if (isRevocation(r.body) && r.body.account === account && r.body.device === cert.body.device && verify(account, revocationBytes(r.body), r.sig)) return "device is revoked";
  return null;
}

// Sharing and rotation (sharing.ts): the account key's word, as above.
export function signGrant(account: AccountKeys, body: Grant): Signed<Grant> {
  return { body, sig: sign(account.sign, grantBytes(body)) };
}

export function signRotation(account: AccountKeys, body: Rotation): Signed<Rotation> {
  return { body, sig: sign(account.sign, rotationBytes(body)) };
}
