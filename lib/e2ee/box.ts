// Wrapping a key to someone's X25519 public key: libsodium's sealed box
// (crypto_box_seal), byte for byte, so the Android app can use libsodium
// itself (test/box.test.ts checks against vectors libsodium made). It's
// anonymous: the recipient learns nothing of who sealed it, which is right
// for wrapping a board key to a member, and why pairing (pairing.ts) uses
// an authenticated exchange instead.
//
//   ephemeral pk (32) || crypto_box(m, nonce = blake2b-24(epk || pk), esk, pk)
//
// crypto_box is X25519, HSalsa20 of the shared point for the key, then
// XSalsa20-Poly1305 (crypto_secretbox), all of them @noble's.

import { x25519 } from "@noble/curves/ed25519.js";
import { xsalsa20poly1305, hsalsa } from "@noble/ciphers/salsa.js";
import { u32, u8 } from "@noble/ciphers/utils.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { random } from "./keys";
import { Tampered } from "./record";
import { concat } from "./wire";

const SIGMA = u32(new TextEncoder().encode("expand 32-byte k"));

// crypto_box_beforenm: HSalsa20 over the shared point with a zero input.
function beforenm(secret: Uint8Array, pub: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secret, pub);
  const out = new Uint32Array(8);
  hsalsa(SIGMA, u32(shared.slice()), new Uint32Array(4), out);
  return u8(out).slice();
}

const nonceOf = (epk: Uint8Array, pk: Uint8Array) => blake2b(concat(epk, pk), { dkLen: 24 });

export const SEAL_OVERHEAD = 32 + 16;

export function sealTo(recipient: Uint8Array, message: Uint8Array): Uint8Array {
  if (recipient.length !== 32) throw new Error("an X25519 key is 32 bytes");
  const esk = random(32);
  const epk = x25519.getPublicKey(esk);
  const c = xsalsa20poly1305(beforenm(esk, recipient), nonceOf(epk, recipient)).encrypt(message);
  esk.fill(0);
  return concat(epk, c);
}

export function openSealed(secret: Uint8Array, pub: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (sealed.length < SEAL_OVERHEAD) throw new Tampered("sealed box");
  const epk = sealed.subarray(0, 32);
  try {
    return xsalsa20poly1305(beforenm(secret, epk), nonceOf(epk, pub)).decrypt(sealed.subarray(32));
  } catch {
    throw new Tampered("sealed box");
  }
}
