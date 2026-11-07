import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Identity, initiate, pipe, respond } from "../../lib/e2ee/channel";
import { checkCert } from "../../lib/e2ee/device";
import { OAuthStore } from "./oauth";
import { node } from "./server";
import { certify, newDevice, revoke } from "../../lib/e2ee/device";
import { type GrantRevocation, forgeGrantHash, grantForge, revokeForgeGrant } from "../../lib/e2ee/forge";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import { type Revocation, type Signed, b64url, utf8 } from "../../lib/e2ee/wire";
import { ANSWER_HEADER, CHAIN_HEADER, channelAnswer, forgeHandler } from "./forge";

const HEADER = "X-Forge-User";
type Seen = { method: string; path: string; user: string | null; chain: string | null; type?: string | null; body?: string };
const seen: Seen[] = [];
const forgejo = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : undefined;
    seen.push({ method: req.method, path: url.pathname + url.search, user: req.headers.get(HEADER), chain: req.headers.get(CHAIN_HEADER), type: req.headers.get("content-type"), body });
    if (url.pathname.endsWith("/git-upload-pack")) return new Response("PACK", { headers: { "content-type": "application/x-git-upload-pack-result" } });
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

  it("takes a spawn key's chain with its answer for this channel's device, and no other", async () => {
    const spawn = newDevice();
    const g = grantForge({ id: laptop.id, sign: laptop.sign }, keys.id, spawn.id, { name: "spawn", repos: ["matt/corkboard"], perms: { contents: "read" }, expires: Date.now() + 3600_000 });
    const chain = header({ cert: laptopCert, grants: [g] });
    const path = "/forge/matt/corkboard.git/info/refs?service=git-upload-pack";
    const signer = { id: spawn.id, sign: spawn.sign };
    expect((await call(path, fleetdCert, { headers: { [CHAIN_HEADER]: chain } })).status).toBe(403);
    const ok = await call(path, fleetdCert, { headers: { [CHAIN_HEADER]: chain, [ANSWER_HEADER]: channelAnswer(signer, fleetd.id) } });
    expect(ok.status).toBe(200);
    expect(last()).toMatchObject({ user: "matt", chain: null });
    expect((await call(path, otherCert, { headers: { [CHAIN_HEADER]: chain, [ANSWER_HEADER]: channelAnswer(signer, fleetd.id) } })).status).toBe(403);
  });

  it("refuses a chain that isn't one", async () => {
    expect((await call("/forge/api/v1/user", fleetdCert, { headers: { [CHAIN_HEADER]: "%%%" } })).status).toBe(400);
  });

  it("is this machine's bridges', on loopback, on the channel to the leader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-"));
    const oauth = new OAuthStore(join(dir, "oauth.json"));
    const none = {} as any;
    // The leader, serving its forge on the channel.
    const leader = node({ data: none, search: none, oauth: new OAuthStore(join(dir, "leader.json")), origin: "http://leader.invalid", forge });
    const me: Identity = { device: laptop, cert: laptopCert, trust: (c) => checkCert(keys.id, c, []) };
    const there = newDevice();
    const them: Identity = { device: there, cert: certify(keys, there, "droplet"), trust: (c) => checkCert(keys.id, c, []) };
    let a: ReturnType<typeof pipe>, b: ReturnType<typeof pipe>;
    a = pipe((m) => queueMicrotask(() => b.deliver(m)), (r) => b.end(r));
    b = pipe((m) => queueMicrotask(() => a.deliver(m)), (r) => a.end(r));
    const [ch] = await Promise.all([initiate(a.link, me, there.id), respond(b.link, them, { serve: (req, c) => leader(req, undefined, c.peer) })]);
    const app = node({ data: none, search: none, oauth, origin: "http://127.0.0.1:1", toForge: (path, init) => ch.fetch(`/forge${path}`, init) });
    const owner = oauth.mint("dev bridge", 1, "owner");
    const local = { requestIP: () => ({ address: "127.0.0.1" }) };
    const ask = (path: string, init: RequestInit = {}, peer = local) => app(new Request(`http://127.0.0.1:1${path}`, { ...init, headers: { Authorization: `Bearer ${owner}`, ...init.headers } }), peer);
    const res = await ask("/app/forge/matt/corkboard.git/git-upload-pack", { method: "POST", headers: { "content-type": "application/x-git-upload-pack-request", [HEADER]: "someone" }, body: "0032want" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    expect(await res.text()).toBe("PACK");
    expect(last()).toMatchObject({ method: "POST", path: "/matt/corkboard.git/git-upload-pack", user: "matt", type: "application/x-git-upload-pack-request", body: "0032want" });
    // Not off loopback, nor with an assistant's token, nor on a channel.
    expect((await ask("/app/forge/api/v1/user", {}, { requestIP: () => ({ address: "10.0.0.2" }) })).status).toBe(404);
    const assistant = oauth.mint("session", 1, "assistant");
    expect((await app(new Request("http://127.0.0.1:1/app/forge/api/v1/user", { headers: { Authorization: `Bearer ${assistant}` } }), local)).status).toBe(404);
    expect((await app(new Request("http://127.0.0.1:1/app/forge/api/v1/user"), undefined, laptopCert)).status).toBe(404);
    ch.close();
    rmSync(dir, { recursive: true });
  });
});
