// Where the page keeps an encrypted account's root: IndexedDB, wrapped one
// of two ways (see .agent/plans/e2ee.md; nothing in the page uses it yet).
//
//   passkey  the WebAuthn PRF extension: a passkey made for this, whose PRF
//            output (HKDF'd) is the key the root is sealed under, so the root
//            opens only with the passkey (and the person at it). Where the
//            browser and authenticator support it.
//   device   elsewhere: an AES-GCM key WebCrypto made non-extractable and
//            IndexedDB keeps, so script can use it but not copy it out. That
//            guards against the root being read off the disk, not against
//            script running on this page.
//
// Either way the page is only as trustworthy as whoever serves it: the plan's
// open question about the web page's trust boundary.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { random } from "../../../lib/e2ee/keys";
import { open, seal } from "../../../lib/e2ee/record";
import { utf8 } from "../../../lib/e2ee/wire";

const DB = "corkboard-e2ee";
const STORE = "keys";
const ROOT = "root";
const AAD = utf8("corkboard-e2ee/v1 stored root");

type Stored =
  | { kind: "passkey"; credential: ArrayBuffer; salt: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array }
  | { kind: "device"; key: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = f(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

// PRF, if this browser says it has it. undefined: it doesn't say (older
// browsers), so making a passkey is the only way to find out.
export async function prfSupported(): Promise<boolean | undefined> {
  if (typeof PublicKeyCredential === "undefined") return false;
  const caps = (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities;
  if (!caps) return undefined;
  try {
    return (await caps())["extension:prf"] ?? undefined;
  } catch {
    return undefined;
  }
}

const kekOf = (prf: ArrayBuffer, salt: Uint8Array) => hkdf(sha256, new Uint8Array(prf), salt, utf8("corkboard-e2ee/v1 passkey kek"), 32);

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

async function prfOutput(credential: ArrayBuffer, salt: Uint8Array): Promise<ArrayBuffer | undefined> {
  const got = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: "public-key", id: credential }],
      userVerification: "required",
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  return (got?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first;
}

// A passkey for the root, and the root sealed under its PRF output; false
// if the authenticator turns out not to have PRF (then use the device key).
export async function saveWithPasskey(root: Uint8Array, account: string, label = "corkboard"): Promise<boolean> {
  if ((await prfSupported()) === false) return false;
  const salt = random(32);
  const made = (await navigator.credentials.create({
    publicKey: {
      challenge: random(32),
      rp: { name: "corkboard" },
      user: { id: utf8(account).slice(0, 64), name: label, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -8 }, { type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!made) return false;
  const ext = made.getClientExtensionResults() as PrfResults;
  if (!ext.prf?.enabled) return false;
  // Some authenticators give the output at creation; the rest need an assertion.
  const prf = ext.prf.results?.first ?? (await prfOutput(made.rawId, salt));
  if (!prf) return false;
  const s = seal(kekOf(prf, salt), root, AAD);
  await idb("readwrite", (st) => st.put({ kind: "passkey", credential: made.rawId, salt, nonce: s.nonce, ciphertext: s.ciphertext } satisfies Stored, ROOT));
  return true;
}

export async function saveWithDeviceKey(root: Uint8Array): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = random(12);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, root.slice());
  await idb("readwrite", (st) => st.put({ kind: "device", key, iv, ciphertext } satisfies Stored, ROOT));
}

// The passkey if it can, else the device key.
export async function saveRoot(root: Uint8Array, account: string): Promise<"passkey" | "device"> {
  try {
    if (await saveWithPasskey(root, account)) return "passkey";
  } catch {
    // Declined, or no authenticator.
  }
  await saveWithDeviceKey(root);
  return "device";
}

export async function loadRoot(): Promise<Uint8Array | undefined> {
  const s = await idb<Stored | undefined>("readonly", (st) => st.get(ROOT));
  if (!s) return;
  if (s.kind === "device") return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: s.iv.slice(), additionalData: AAD }, s.key, s.ciphertext));
  const prf = await prfOutput(s.credential, s.salt);
  if (!prf) throw new Error("the passkey gave no PRF output");
  return open(kekOf(prf, s.salt), { nonce: s.nonce, ciphertext: s.ciphertext }, AAD, "the stored root");
}

export const forgetRoot = () => idb("readwrite", (st) => st.delete(ROOT));
