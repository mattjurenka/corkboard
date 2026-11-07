import { afterAll, describe, expect, it } from "bun:test";
import { certify, newDevice, revoke } from "../../lib/e2ee/device";
import { type GrantRevocation, forgeGrantHash, grantForge, revokeForgeGrant } from "../../lib/e2ee/forge";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import { type Revocation, type Signed, b64url, utf8 } from "../../lib/e2ee/wire";
import { CHAIN_HEADER, forgeHandler } from "./forge";

const HEADER = "X-Forge-User";
type Seen = { method: string; path: string; user: string | null; chain: string | null };
const seen: Seen[] = [];
const forgejo = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ method: req.method, path: url.pathname + url.search, user: req.headers.get(HEADER), chain: req.headers.get(CHAIN_HEADER) });
    return Response.json({ ok: true });
  },
});
afterAll(() => forgejo.stop(true));

const keys = accountKeys(newRoot());
const laptop = newDevice();
const laptopCert = certify(keys, laptop, "laptop");
const fleetd = newDevice();
const fleetdCert = certify(keys, fleetd, "fleetd", Date.now(), "relay");
const other = newDevice();
const otherCert = certify(keys, other, "other fleetd", Date.now(), "relay");

let user: string | undefined = "matt";
const revocations: Signed<Revocation>[] = [];
const grantRevocations: Signed<GrantRevocation>[] = [];
const forge = forgeHandler({
  upstream: forgejo.url.href,
  userHeader: HEADER,
  records: { user: () => user, revokedBy: (h) => grantRevocations.filter((r) => r.body.grant === h).map((r) => r.body.by) },
  account: () => ({ id: keys.id, key: keys.id }),
  revocations: async () => revocations,
});

const grant = (repos = ["matt/corkboard"]) =>
  grantForge({ id: laptop.id, sign: laptop.sign }, keys.id, fleetd.id, { name: "spawn", repos, perms: { contents: "write" }, refs: ["agent/*"], expires: Date.now() + 3600_000 });
const header = (chain: unknown) => b64url(utf8(JSON.stringify(chain)));
const call = (path: string, from = laptopCert, init: RequestInit = {}) => forge(new Request(`http://node.invalid${path}`, init), from);
const last = () => seen[seen.length - 1];

describe("the node's forge", () => {
  it("lets a full device in as the account's user, the /forge prefix gone", async () => {
    const res = await call("/forge/api/v1/user", laptopCert, { headers: { [HEADER]: "someone" } });
    expect(res.status).toBe(200);
    expect(last()).toMatchObject({ path: "/api/v1/user", user: "matt" });
  });

  it("says so when the account has no forge", async () => {
    user = undefined;
    expect((await call("/forge/api/v1/user")).status).toBe(503);
    user = "matt";
  });

  it("wants a relay-only device's grant, and holds it to it", async () => {
    expect((await call("/forge/api/v1/user", fleetdCert)).status).toBe(401);
    const g = grant();
    const chain = header({ cert: laptopCert, grants: [g] });
    const ok = await call("/forge/matt/corkboard.git/info/refs?service=git-upload-pack", fleetdCert, { headers: { [CHAIN_HEADER]: chain } });
    expect(ok.status).toBe(200);
    expect(last()).toMatchObject({ path: "/matt/corkboard.git/info/refs?service=git-upload-pack", user: "matt", chain: null });
    expect((await call("/forge/matt/secret.git/info/refs?service=git-upload-pack", fleetdCert, { headers: { [CHAIN_HEADER]: chain } })).status).toBe(403);
    expect((await call("/forge/api/v1/user", fleetdCert, { headers: { [CHAIN_HEADER]: chain } })).status).toBe(403);
  });

  it("refuses a grant shown by a device it isn't to", async () => {
    const chain = header({ cert: laptopCert, grants: [grant()] });
    const res = await call("/forge/matt/corkboard.git/info/refs?service=git-upload-pack", otherCert, { headers: { [CHAIN_HEADER]: chain } });
    expect(res.status).toBe(403);
  });

  it("refuses a revoked grant, and a revoked issuer's", async () => {
    const g = grant();
    const chain = header({ cert: laptopCert, grants: [g] });
    const path = "/forge/matt/corkboard.git/info/refs?service=git-upload-pack";
    grantRevocations.push(revokeForgeGrant({ id: laptop.id, sign: laptop.sign }, keys.id, forgeGrantHash(g.body)));
    expect((await call(path, fleetdCert, { headers: { [CHAIN_HEADER]: chain } })).status).toBe(403);
    grantRevocations.length = 0;
    const fresh = forgeHandler({
      upstream: forgejo.url.href,
      userHeader: HEADER,
      records: { user: () => "matt", revokedBy: () => [] },
      account: () => ({ id: keys.id, key: keys.id }),
      revocations: async () => [revoke(keys, laptop.id)],
    });
    expect((await fresh(new Request(`http://node.invalid${path}`, { headers: { [CHAIN_HEADER]: chain } }), fleetdCert)).status).toBe(403);
  });

  it("refuses a chain that isn't one", async () => {
    expect((await call("/forge/api/v1/user", fleetdCert, { headers: { [CHAIN_HEADER]: "%%%" } })).status).toBe(400);
  });
});
