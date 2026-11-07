// Where this machine keeps its end-to-end encryption keys: e2ee/ in the
// state directory (dirs.ts), readable only by this user.
//
//   device.json   this device's own signing and box keys, its certificate, the relay
//                 (null for an account only on this machine: e2ee init --local)
//   root.json     the account root, encrypted (XChaCha20-Poly1305) under a key-encrypting key
//   rotating.json a rotation's new root, the same way, kept until the relay has it
//   token.json    the relay's current token
//   replicas.db   each object's replica (lib/e2ee/sync.ts): cursor, merged state, queue
//                 (replicadb.ts; replicas/<object>.json before, moved in when opened)
//
// The key-encrypting key comes from a passphrase (scrypt), when one was
// given at init, or from the keychain. Keychain is the seam for the OS's
// own (libsecret, the macOS keychain, DPAPI, Electron's safeStorage); for
// now the only one is a file beside the root, so the root is only as safe
// as this directory's permissions, as auth.json is.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { STATE_DIR } from "./dirs";
import { type Device, fromSecrets } from "../lib/e2ee/device";
import { random } from "../lib/e2ee/keys";
import { open, seal } from "../lib/e2ee/record";
import type { Chain } from "../lib/e2ee/forge";
import type { ReplicaStore } from "../lib/e2ee/sync";
import { ReplicaDb } from "./replicadb";
import type { Token } from "../lib/e2ee/relay";
import { type DeviceCert, type Signed, b64url, fromB64url, utf8 } from "../lib/e2ee/wire";

export const E2EE_DIR = join(STATE_DIR, "e2ee");

export type Keychain = { name: string; get(): Promise<Uint8Array | undefined>; set(kek: Uint8Array): Promise<void> };

export function fileKeychain(dir: string): Keychain {
  const path = join(dir, "kek");
  return {
    name: "file",
    get: async () => (existsSync(path) ? fromB64url(readFileSync(path, "utf8").trim()) : undefined),
    set: async (kek) => write(path, b64url(kek) + "\n"),
  };
}

function write(path: string, text: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

type RootFile = { v: 1; kek: "keychain" | "scrypt"; keychain?: string; salt?: string; nonce: string; ciphertext: string };
export type ForgeFile = {
  v: 1;
  gate: string;
  account: string;
  user?: string;
  grants: { hash: string; name: string; holder: string; expires: number; chain: Chain }[];
};
type DeviceFile = { v: 1; relay: string | null; name: string; sign: string; box: string; cert: Signed<DeviceCert> };

// scrypt's cost: 64 MB and about a second.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, dkLen: 32 };
const ROOT_AAD = utf8("corkboard-e2ee/v1 stored root");

export class Keystore {
  private db?: ReplicaDb;

  constructor(
    readonly dir = E2EE_DIR,
    private keychain: Keychain = fileKeychain(dir),
  ) {}

  private ensure() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  exists() {
    return existsSync(join(this.dir, "root.json")) && existsSync(join(this.dir, "device.json"));
  }

  needsPassphrase() {
    return readJson<RootFile>(join(this.dir, "root.json"))?.kek === "scrypt";
  }

  async saveRoot(root: Uint8Array, passphrase?: string, file = "root.json") {
    this.ensure();
    let kek: Uint8Array;
    let f: Omit<RootFile, "nonce" | "ciphertext">;
    if (passphrase) {
      const salt = random(16);
      kek = await scryptAsync(utf8(passphrase.normalize("NFKC")), salt, SCRYPT);
      f = { v: 1, kek: "scrypt", salt: b64url(salt) };
    } else {
      kek = (await this.keychain.get()) ?? random(32);
      await this.keychain.set(kek);
      f = { v: 1, kek: "keychain", keychain: this.keychain.name };
    }
    const s = seal(kek, root, ROOT_AAD);
    write(join(this.dir, file), JSON.stringify({ ...f, nonce: b64url(s.nonce), ciphertext: b64url(s.ciphertext) }, null, 2) + "\n");
  }

  async root(passphrase?: string, file = "root.json"): Promise<Uint8Array> {
    const f = readJson<RootFile>(join(this.dir, file));
    if (!f) throw new Error(`no account on this machine (${this.dir}); corkboard-bridge e2ee init, recover or pair`);
    let kek: Uint8Array | undefined;
    if (f.kek === "scrypt") {
      if (!passphrase) throw new Error("the root is under a passphrase: give it with --passphrase or CORKBOARD_E2EE_PASSPHRASE");
      kek = await scryptAsync(utf8(passphrase.normalize("NFKC")), fromB64url(f.salt!), SCRYPT);
    } else kek = await this.keychain.get();
    if (!kek) throw new Error(`the key for the root isn't in the ${this.keychain.name} keychain`);
    try {
      return open(kek, { nonce: fromB64url(f.nonce), ciphertext: fromB64url(f.ciphertext) }, ROOT_AAD, "the stored root");
    } catch {
      throw new Error(f.kek === "scrypt" ? "wrong passphrase" : "the stored root doesn't open with the keychain's key");
    }
  }

  saveDevice(relay: string | null, name: string, device: Device, cert: Signed<DeviceCert>) {
    this.ensure();
    const f: DeviceFile = { v: 1, relay, name, sign: b64url(device.sign.secret), box: b64url(device.box.secret), cert };
    write(join(this.dir, "device.json"), JSON.stringify(f, null, 2) + "\n");
  }

  device(): { relay: string | null; name: string; device: Device; cert: Signed<DeviceCert> } | undefined {
    const f = readJson<DeviceFile>(join(this.dir, "device.json"));
    return f && { relay: f.relay, name: f.name, device: fromSecrets(fromB64url(f.sign), fromB64url(f.box)), cert: f.cert };
  }

  token(): Token | undefined {
    return readJson<Token>(join(this.dir, "token.json"));
  }

  saveToken(t: Token) {
    this.ensure();
    write(join(this.dir, "token.json"), JSON.stringify(t) + "\n");
  }

  // The forge gate this account is bound at, and the git access given from
  // here (e2ee.ts's forge*).
  forge(): ForgeFile | undefined {
    return readJson<ForgeFile>(join(this.dir, "forge.json"));
  }

  saveForge(f: ForgeFile) {
    this.ensure();
    write(join(this.dir, "forge.json"), JSON.stringify(f, null, 2) + "\n");
  }

  replica(object: string): ReplicaStore {
    if (!this.db) {
      this.ensure();
      this.db = new ReplicaDb(join(this.dir, "replicas.db"));
    }
    return this.db.store(object, join(this.dir, "replicas", `${object}.json`));
  }

  // Everything, for a device that's leaving the account.
  forget() {
    this.db?.close();
    this.db = undefined;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
