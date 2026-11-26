// Add a fleet host (e2ee.ts's fleetCertify) against the real corkboard-fleet:
// what `device` prints on the host, pasted whole, comes back as a cert that
// `device cert` keeps.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify, newDevice } from "../lib/e2ee/device";
import { accountKeys, newRoot } from "../lib/e2ee/keys";
import { fleetCertify } from "./e2ee";
import { Keystore } from "./keystore";

const dir = mkdtempSync(join(tmpdir(), "corkboard-fleet-host-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const RELAY = "https://relay.test";
const FLEET = join(import.meta.dir, "../fleet/fleetd/cli.ts");

// A machine in an account, its root under pass if there's one.
async function machine(name: string, pass?: string) {
  const store = new Keystore(join(dir, name));
  const root = newRoot();
  const d = newDevice();
  await store.saveRoot(root, pass);
  store.saveDevice(RELAY, name, d, certify(accountKeys(root), d, name));
  return { at: { store, relay: RELAY }, account: accountKeys(root).id };
}

async function fleet(args: string[], input = "") {
  const p = Bun.spawn([process.execPath, FLEET, ...args], {
    env: { ...process.env, CORKBOARD_FLEET_MANIFEST: join(dir, "none.json"), CORKBOARD_FLEET_STATE: join(dir, "fleet") },
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

test("what the host printed, pasted whole, is certified as its relay-only device, and the host keeps the cert", async () => {
  const file = join(dir, "device.json");
  const said = await fleet(["device", file]);
  expect(said.code).toBe(0);
  expect(said.out).toContain("Add a fleet host");
  const m = await machine("laptop");
  const got = await fleetCertify(said.out, undefined, m.at);
  const id = said.out.match(/: device (\S+)/)![1];
  expect(got).toMatchObject({ device: id, name: "fleetd" });
  expect(JSON.parse(got.cert).body).toMatchObject({ account: m.account, device: id, name: "fleetd", role: "relay" });
  // The command it hands back names the file the host did.
  expect(got.command).toBe(`corkboard-fleet device cert ${file} <<'EOF'\n${got.cert}\nEOF`);
  expect(await fleet(["device", "cert", file], got.cert)).toMatchObject({ code: 0, err: "" });
  expect(JSON.parse(readFileSync(file, "utf8")).cert.body.device).toBe(id);
});

test("just the id and the box key will do, with a name; less than that won't", async () => {
  const m = await machine("desk");
  const d = newDevice();
  const box = Buffer.from(d.box.public).toString("base64url");
  const got = await fleetCertify(`${d.id} ${box} --name omni`, undefined, m.at);
  expect(got).toMatchObject({ device: d.id, name: "omni", command: `corkboard-fleet device cert <<'EOF'\n${got.cert}\nEOF` });
  expect(JSON.parse(got.cert).body.box).toBe(box);
  await expect(fleetCertify(`device ${d.id} and ${d.id} again`, undefined, m.at)).rejects.toThrow(/no device in it/);
  await expect(fleetCertify("", undefined, m.at)).rejects.toThrow(/no device in it/);
});

test("a machine in no account, or on another relay, certifies nothing; a root under a passphrase wants it", async () => {
  const d = newDevice();
  const said = `${d.id} ${Buffer.from(d.box.public).toString("base64url")}`;
  await expect(fleetCertify(said, undefined, { store: new Keystore(join(dir, "nobody")), relay: RELAY })).rejects.toThrow(/isn't in an account/);
  const m = await machine("locked", "correct horse");
  await expect(fleetCertify(said, undefined, { ...m.at, relay: "https://other.test" })).rejects.toThrow(/isn't in an account/);
  const { CORKBOARD_E2EE_PASSPHRASE: kept } = process.env;
  delete process.env.CORKBOARD_E2EE_PASSPHRASE;
  try {
    await expect(fleetCertify(said, "wrong", m.at)).rejects.toThrow(/passphrase/);
    expect((await fleetCertify(said, "correct horse", m.at)).device).toBe(d.id);
  } finally {
    if (kept !== undefined) process.env.CORKBOARD_E2EE_PASSPHRASE = kept;
  }
});
