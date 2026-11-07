// An SSH key's signature (ssh-keygen -Y sign, armored) over some bytes, by
// one of a user's keys: checked by ssh-keygen itself.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/;
const ARMOR = /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]+-----END SSH SIGNATURE-----\n?$/;

export async function sshSigned(keys: string[], namespace: string, bytes: Uint8Array, sig: string): Promise<boolean> {
  const lines = keys.map((k) => k.trim().split(" ").slice(0, 2).join(" ")).filter((k) => KEY_LINE.test(k));
  if (!lines.length || !ARMOR.test(sig)) return false;
  const dir = await mkdtemp(join(tmpdir(), "forge-gate-"));
  try {
    await writeFile(join(dir, "allowed"), lines.map((k) => `signer namespaces="${namespace}" ${k}\n`).join(""));
    await writeFile(join(dir, "sig"), sig);
    const p = Bun.spawn(["ssh-keygen", "-Y", "verify", "-f", join(dir, "allowed"), "-I", "signer", "-n", namespace, "-s", join(dir, "sig")], { stdin: bytes, stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
