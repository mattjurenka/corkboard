import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keystore } from "./keystore";
import { accountKeys, newRoot } from "../lib/e2ee/keys";
import { certify, newDevice } from "../lib/e2ee/device";
import { b64url } from "../lib/e2ee/wire";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "corkboard-keystore-"));
  dirs.push(d);
  return new Keystore(join(d, "e2ee"));
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("the bridge's keystore", () => {
  it("keeps the root encrypted, and gives it back", async () => {
    const ks = fresh();
    const root = newRoot();
    await ks.saveRoot(root);
    expect(ks.needsPassphrase()).toBe(false);
    expect(await ks.root()).toEqual(root);
    const file = readFileSync(join(ks.dir, "root.json"), "utf8");
    expect(file).not.toContain(b64url(root));
    if (process.platform !== "win32") {
      expect(statSync(join(ks.dir, "root.json")).mode & 0o777).toBe(0o600);
      expect(statSync(ks.dir).mode & 0o777).toBe(0o700);
    }
  });

  it("under a passphrase, wants the right one", async () => {
    const ks = fresh();
    const root = newRoot();
    await ks.saveRoot(root, "correct horse");
    expect(ks.needsPassphrase()).toBe(true);
    expect(await ks.root("correct horse")).toEqual(root);
    await expect(ks.root("wrong")).rejects.toThrow(/wrong passphrase/);
    await expect(ks.root()).rejects.toThrow(/passphrase/);
  });

  it("keeps the device and its certificate", () => {
    const ks = fresh();
    const keys = accountKeys(newRoot());
    const d = newDevice();
    const cert = certify(keys, d, "laptop");
    ks.saveDevice("https://relay.test", "laptop", d, cert);
    const back = ks.device()!;
    expect(back.device.id).toBe(d.id);
    expect(back.device.box.public).toEqual(d.box.public);
    expect(back.cert).toEqual(cert);
  });
});
