// Give git access (e2ee.ts's forgeGrant): what it signs is a chain the
// forge gate takes, and it's kept to be taken back.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKeys, newRoot } from "../lib/e2ee/keys";
import { certify, newDevice } from "../lib/e2ee/device";
import { checkChain } from "../lib/e2ee/forge";

const dir = mkdtempSync(join(tmpdir(), "corkboard-forge-"));
process.env.CORKBOARD_STATE_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const root = newRoot();
const keys = accountKeys(root);
const holder = newDevice();
let e2ee: typeof import("./e2ee");
let store: import("./keystore").Keystore;

beforeAll(async () => {
  const { Keystore } = await import("./keystore");
  const { CLOUD } = await import("./cloud");
  store = new Keystore(join(dir, "e2ee"));
  const device = newDevice();
  await store.saveRoot(root);
  store.saveDevice(CLOUD, "laptop", device, certify(keys, device, "laptop"));
  e2ee = await import("./e2ee");
  store.saveForge({ v: 1, gate: e2ee.FORGE_GATE, account: keys.id, user: "matt", grants: [] });
});

const none = { devices: [], grant: () => false };

describe("Give git access", () => {
  it("signs a chain the gate takes, as narrow as asked", async () => {
    const got = await e2ee.forgeGrant({ holder: holder.id, name: "vm", repos: "matt/corkboard", perms: "contents:write issues", refs: "agent/*", days: 7 });
    const checked = checkChain(keys.id, keys.id, got.chain, none);
    if (typeof checked === "string") throw new Error(checked);
    expect(checked.holder).toBe(holder.id);
    expect(checked.scope).toMatchObject({ repos: ["matt/corkboard"], perms: { metadata: "read", contents: "write", issues: "read" }, refs: ["refs/heads/agent/*"] });
    expect(store.forge()!.grants.map((g) => g.hash)).toEqual([got.hash]);
    expect(e2ee.forgeStatus()).toMatchObject({ account: true, user: "matt", grants: 1 });
  });

  it("refuses what isn't a grant", async () => {
    await expect(e2ee.forgeGrant({ holder: "not a key", name: "", repos: "matt/x", perms: "", refs: "", days: 1 })).rejects.toThrow("holder");
    await expect(e2ee.forgeGrant({ holder: holder.id, name: "", repos: "matt/x", perms: "contents:admin", refs: "", days: 1 })).rejects.toThrow("permission");
    await expect(e2ee.forgeGrant({ holder: holder.id, name: "", repos: "not a repo", perms: "", refs: "", days: 1 })).rejects.toThrow("repos");
    await expect(e2ee.forgeGrant({ holder: holder.id, name: "", repos: "matt/x", perms: "", refs: "", days: 0 })).rejects.toThrow("days");
  });
});
