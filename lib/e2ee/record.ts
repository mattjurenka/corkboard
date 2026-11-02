// Records: XChaCha20-Poly1305 (libsodium's crypto_aead_xchacha20poly1305_ietf)
// with a random 24-byte nonce, and associated data naming the object and
// the op, so the relay can't move a record to another log or swap two ops'
// bodies without the open failing.
//
// Attachments are records too, bound to their blob's id, under a key of
// their own that the op naming them carries.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { random } from "./keys";
import { fromUtf8, utf8, VERSION } from "./wire";

export type Sealed = { nonce: Uint8Array; ciphertext: Uint8Array };

export const NONCE = 24;
// Poly1305's tag, which every ciphertext is longer than its plaintext by.
export const TAG = 16;

export class Tampered extends Error {
  constructor(what: string) {
    super(`${what}: doesn't decrypt (wrong key, or changed)`);
  }
}

export const aad = (object: string, op: string) => utf8(`${VERSION} record\0${object}\0${op}`);
const blobAad = (blob: string) => utf8(`${VERSION} blob\0${blob}`);

export function seal(key: Uint8Array, plaintext: Uint8Array, data: Uint8Array): Sealed {
  const nonce = random(NONCE);
  return { nonce, ciphertext: xchacha20poly1305(key, nonce, data).encrypt(plaintext) };
}

export function open(key: Uint8Array, s: Sealed, data: Uint8Array, what = "record"): Uint8Array {
  if (s.nonce.length !== NONCE || s.ciphertext.length < TAG) throw new Tampered(what);
  try {
    return xchacha20poly1305(key, s.nonce, data).decrypt(s.ciphertext);
  } catch {
    throw new Tampered(what);
  }
}

export const sealRecord = (key: Uint8Array, object: string, op: string, body: unknown) => seal(key, utf8(JSON.stringify(body)), aad(object, op));
export const openRecord = <T>(key: Uint8Array, object: string, op: string, s: Sealed): T => JSON.parse(fromUtf8(open(key, s, aad(object, op), `op ${op}`))) as T;

// A blob is its nonce then its ciphertext, as one upload.
export function sealBlob(key: Uint8Array, blob: string, bytes: Uint8Array): Uint8Array {
  const s = seal(key, bytes, blobAad(blob));
  const out = new Uint8Array(NONCE + s.ciphertext.length);
  out.set(s.nonce);
  out.set(s.ciphertext, NONCE);
  return out;
}

export const openBlob = (key: Uint8Array, blob: string, bytes: Uint8Array) =>
  open(key, { nonce: bytes.subarray(0, NONCE), ciphertext: bytes.subarray(NONCE) }, blobAad(blob), `blob ${blob}`);
