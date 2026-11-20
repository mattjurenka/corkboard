// keystore.ts against fake-indexeddb and a stand-in authenticator whose PRF
// is HMAC-SHA256 under a secret of each credential's: the root back from
// either way it's kept, the passkey's fallbacks to the device key, and a
// passkey that isn't the one it was sealed under.
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test } from "bun:test";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { forgetRoot, loadRoot, prfSupported, saveRoot, saveWithDeviceKey, saveWithPasskey } from "./keystore";

type Authenticator = {
  // What getClientCapabilities says of PRF; absent: there's no such method.
  caps?: boolean;
  // Whether a passkey made has PRF, and gives its output at creation.
  prf?: boolean;
  atCreate?: boolean;
  // Creating one is declined.
  declines?: boolean;
};

let made: Map<string, Uint8Array>;
let a: Authenticator;
let asserted: number;

const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");
const output = (secret: Uint8Array, salt: BufferSource) => hmac(sha256, secret, new Uint8Array(salt as ArrayBuffer)).buffer as ArrayBuffer;
const saltOf = (ext: any) => ext.prf.eval.first as BufferSource;

const credentials = {
  async create({ publicKey }: CredentialCreationOptions) {
    if (a.declines) throw new DOMException("declined", "NotAllowedError");
    const id = crypto.getRandomValues(new Uint8Array(16));
    const secret = crypto.getRandomValues(new Uint8Array(32));
    made.set(hex(id), secret);
    const results = a.atCreate ? { first: output(secret, saltOf(publicKey!.extensions)) } : undefined;
    return { rawId: id.buffer, getClientExtensionResults: () => ({ prf: { enabled: a.prf, results } }) };
  },
  async get({ publicKey }: CredentialRequestOptions) {
    asserted++;
    const id = publicKey!.allowCredentials![0].id as ArrayBuffer;
    const secret = made.get(hex(id));
    if (!secret) throw new DOMException("no such credential", "NotAllowedError");
    return { getClientExtensionResults: () => ({ prf: { results: { first: output(secret, saltOf(publicKey!.extensions)) } } }) };
  },
};
Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  made = new Map();
  asserted = 0;
  a = { caps: true, prf: true, atCreate: true };
  (globalThis as any).PublicKeyCredential = class {
    static getClientCapabilities = "caps" in a ? async () => ({ "extension:prf": a.caps }) : undefined;
  };
});

const root = () => crypto.getRandomValues(new Uint8Array(32));

describe("keystore", () => {
  test("nothing kept: no root", async () => {
    expect(await loadRoot()).toBeUndefined();
  });

  test("the device key: the root back, and gone once forgotten", async () => {
    const r = root();
    await saveWithDeviceKey(r);
    expect(await loadRoot()).toEqual(r);
    await forgetRoot();
    expect(await loadRoot()).toBeUndefined();
  });

  test("a passkey whose output comes at creation: the root back through an assertion", async () => {
    const r = root();
    expect(await saveRoot(r, "acct-1")).toBe("passkey");
    expect(asserted).toBe(0);
    expect(await loadRoot()).toEqual(r);
    expect(asserted).toBe(1);
  });

  test("a passkey whose output needs an assertion", async () => {
    a.atCreate = false;
    const r = root();
    expect(await saveWithPasskey(r, "acct-1")).toBe(true);
    expect(asserted).toBe(1);
    expect(await loadRoot()).toEqual(r);
  });

  test("the device key when PRF isn't there, the passkey's declined, or it has no PRF", async () => {
    for (const set of [() => (a.caps = false), () => (a.declines = true), () => (a.prf = false)]) {
      globalThis.indexedDB = new IDBFactory();
      a = { caps: true, prf: true, atCreate: true };
      set();
      const r = root();
      expect(await saveRoot(r, "acct-1")).toBe("device");
      expect(await loadRoot()).toEqual(r);
    }
  });

  test("a browser that doesn't say: making a passkey finds out", async () => {
    a = { prf: true, atCreate: true };
    (globalThis as any).PublicKeyCredential = class {};
    expect(await prfSupported()).toBeUndefined();
    expect(await saveRoot(root(), "acct-1")).toBe("passkey");
    delete (globalThis as any).PublicKeyCredential;
    expect(await prfSupported()).toBe(false);
  });

  test("another passkey's output doesn't open it", async () => {
    await saveWithPasskey(root(), "acct-1");
    // The same credential id, a different secret: another authenticator's.
    for (const id of made.keys()) made.set(id, crypto.getRandomValues(new Uint8Array(32)));
    await expect(loadRoot()).rejects.toThrow();
  });

  test("a later save is the one kept", async () => {
    await saveWithDeviceKey(root());
    const r = root();
    await saveWithPasskey(r, "acct-1");
    expect(await loadRoot()).toEqual(r);
  });
});
