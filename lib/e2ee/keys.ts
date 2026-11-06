// The account's keys, all from one 32-byte root made on its first device
// (and kept as its recovery phrase, phrase.ts). HKDF-SHA256 derives the
// rest, each under a label of its own, so no key is ever used for two
// things:
//
//   root ─┬─ account signing key (Ed25519): the account's id, signs device certs
//         ├─ account box key (X25519): what's wrapped to the account
//         └─ per object (board, brain, memory): its key, and its opaque id
//
// A board's key is derived, not random, so a device with the root needs
// nothing else to read it; it's still a key of its own, and can later be
// wrapped to a collaborator (box.ts) without giving them the root.
//
// Device keys (device.ts) are random, one pair per device, never derived.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64url, utf8, VERSION } from "./wire";

export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export const newRoot = () => random(32);

const SALT = utf8(`${VERSION} root`);

export function derive(root: Uint8Array, label: string, length = 32): Uint8Array {
  if (root.length !== 32) throw new Error("a root is 32 bytes");
  return hkdf(sha256, root, SALT, utf8(label), length);
}

export type KeyPair = { secret: Uint8Array; public: Uint8Array };

export type AccountKeys = {
  // The account signing key's public half, base64url: what the relay knows the account by.
  id: string;
  sign: KeyPair;
  box: KeyPair;
};

export function signPair(seed: Uint8Array): KeyPair {
  return { secret: seed, public: ed25519.getPublicKey(seed) };
}

export function boxPair(secret: Uint8Array): KeyPair {
  return { secret, public: x25519.getPublicKey(secret) };
}

export function accountKeys(root: Uint8Array): AccountKeys {
  const sign = signPair(derive(root, "account sign"));
  return { id: b64url(sign.public), sign, box: boxPair(derive(root, "account box")) };
}

// account: what the account's nodes share among themselves, by name
// (bridge/node's "oauth": claude.ai's grants, so they fail over). day: the
// account's day plans and chat, one object named "day" (bridge/node/day.ts).
// fleet: what the fleet keeps sealed from the Worker, one object named
// "fleet" (bridge/node/fleet.ts).
export type ObjectKind = "board" | "brain" | "memory" | "index" | "account" | "day" | "fleet";
export const KINDS: ObjectKind[] = ["board", "brain", "memory", "index", "account", "day", "fleet"];

// An object's name (a board's key, a brain's name) goes in neither the
// relay's view nor its ids: both are HKDF outputs.
const label = (kind: ObjectKind, name: string) => {
  if (!KINDS.includes(kind)) throw new Error(`no kind ${kind}`);
  return `${kind}\0${name}`;
};

export const objectKey = (root: Uint8Array, kind: ObjectKind, name: string) => derive(root, `object key ${label(kind, name)}`);

// 128 bits, as 22 base64url characters: the log's id on the relay.
export const objectId = (root: Uint8Array, kind: ObjectKind, name: string) => b64url(derive(root, `object id ${label(kind, name)}`, 16));
