import { afterAll, describe, expect, it } from "bun:test";
import { type Device, certify, creation, newDevice, revoke, signRotation } from "../../lib/e2ee/device";
import { FORGE_BIND_SSH, type ForgeGrant, type GrantTerms, answerForge, bindForge, bindForgeAsDevice, forgeBindBytes, forgeGrantHash, grantForge, revokeForgeGrant } from "../../lib/e2ee/forge";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import { type AccountView, type DeviceCert, type Signed, b64url } from "../../lib/e2ee/wire";
import { sendRevocationToGate } from "../../lib/e2ee/forge-client";
import { createGate } from "./gate";
import { Store } from "./store";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = "https://git.test";

// SSH keys: matt's, which Forgejo has, and a stranger's.
const sshDir = mkdtempSync(join(tmpdir(), "gate-test-"));
const sshKey = (name: string) => {
  Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(sshDir, name)]);
  return join(sshDir, name);
};
const mattKey = sshKey("matt");
const strangerKey = sshKey("stranger");
const sshSign = (key: string, bytes: Uint8Array) => Bun.spawnSync(["ssh-keygen", "-Y", "sign", "-q", "-f", key, "-n", FORGE_BIND_SSH], { stdin: bytes }).stdout.toString();
const HEADER = "X-Forge-User";

// Forgejo, as much as the gate asks of it; anything else answers with what it was sent.
type Seen = { method: string; path: string; user: string | null; auth: string | null; body: string };
const seen: Seen[] = [];
const forgejo = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const user = req.headers.get(HEADER);
    const p = url.pathname;
    if (p === "/api/v1/user/keys") return user === "matt" ? Response.json([{ key: readFileSync(mattKey + ".pub", "utf8").trim() }]) : new Response("no", { status: 401 });
    if (p === "/api/v1/user") return req.headers.get("authorization") === "token good" ? Response.json({ login: "matt" }) : new Response("no", { status: 401 });
    if (p === "/api/v1/repos/matt/corkboard" && req.method === "GET") return Response.json({ default_branch: "main" });
    if (p === "/api/v1/repos/matt/corkboard/issues/5") return Response.json({ number: 5, pull_request: { merged: false } });
    if (p === "/api/v1/repos/matt/corkboard/issues/6") return Response.json({ number: 6, pull_request: null });
    if (p === "/api/v1/repos/matt/corkboard/pulls/5") return Response.json({ base: { ref: "main", repo: { id: 1 } }, head: { ref: "agent/x", repo: { id: 1 } } });
    const body = await req.text();
    seen.push({ method: req.method, path: p + url.search, user, auth: req.headers.get("authorization"), body });
    return Response.json({ ok: true });
  },
});
afterAll(() => forgejo.stop(true));

const gate = createGate({ origin: ORIGIN, upstream: forgejo.url.href, userHeader: HEADER, corsOrigins: ["https://corkboard.test"], store: new Store(":memory:") });
const call = (path: string, init: RequestInit = {}) => gate.fetch(new Request(ORIGIN + path, init));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const last = () => seen[seen.length - 1];

function account() {
  const keys = accountKeys(newRoot());
  const laptop = newDevice();
  const cert = certify(keys, laptop, "laptop");
  const view: AccountView = { id: keys.id, key: keys.id, box: b64url(keys.box.public), proof: { creation: creation(keys, "https://relay.test", null), rotations: [] } };
  return { keys, id: keys.id, laptop, cert, view };
}

async function bound() {
  const a = account();
  const res = await post("/gate/bind", { view: a.view, bind: bindForge(a.keys, a.id, ORIGIN, "matt"), forgejo_token: "good" });
  expect(res.status).toBe(201);
  return a;
}

async function session(id: string, holder: Device, cert: Signed<DeviceCert>, grants: Signed<ForgeGrant>[] = []) {
  const { nonce } = (await (await call("/gate/challenge")).json()) as { nonce: string };
  const res = await post("/gate/session", { account: id, chain: { cert, grants }, answer: answerForge(holder, ORIGIN, nonce) });
  const out = (await res.json()) as { token?: string; error?: string };
  if (!out.token) throw new Error(out.error);
  return { authorization: `Bearer ${out.token}` };
}

const EXPIRES = Date.now() + 3600_000;
const terms = (t: Partial<GrantTerms> = {}): GrantTerms => ({ name: "vm", repos: ["matt/corkboard"], perms: { contents: "write", issues: "write" }, refs: ["agent/*"], expires: EXPIRES, ...t });

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
const pushBody = (ref: string) => pkt(`${"0".repeat(40)} ${"a".repeat(40)} ${ref}\0report-status side-band-64k\n`) + "0000" + "PACK...the pack";

describe("binding", () => {
  it("takes a token of the user's, and not another's", async () => {
    const a = account();
    expect((await post("/gate/bind", { view: a.view, bind: bindForge(a.keys, a.id, ORIGIN, "matt"), forgejo_token: "bad" })).status).toBe(403);
    expect((await post("/gate/bind", { view: a.view, bind: bindForge(a.keys, a.id, "https://elsewhere", "matt"), forgejo_token: "good" })).status).toBe(400);
    expect((await post("/gate/bind", { view: a.view, bind: bindForge(a.keys, a.id, ORIGIN, "matt"), forgejo_token: "good" })).status).toBe(201);
  });

  it("takes a full device's binding, shown by an SSH key Forgejo has for the user", async () => {
    const a = account();
    const bind = bindForgeAsDevice(a.laptop, a.id, a.keys.id, ORIGIN, "matt");
    const bytes = forgeBindBytes(bind.body);
    expect((await post("/gate/bind", { view: a.view, bind, cert: a.cert, ssh: [sshSign(strangerKey, bytes)] })).status).toBe(403);
    expect((await post("/gate/bind", { view: a.view, bind, ssh: [sshSign(mattKey, bytes)] })).status).toBe(403);
    expect((await post("/gate/bind", { view: a.view, bind, cert: a.cert, ssh: [sshSign(strangerKey, bytes), sshSign(mattKey, bytes)] })).status).toBe(201);
    expect((await session(a.id, a.laptop, a.cert)).authorization).toStartWith("Bearer cbg_");
  });

  it("a relay-only device can't bind", async () => {
    const a = account();
    const vm = newDevice();
    const cert = certify(a.keys, vm, "vm", Date.now(), "relay");
    const bind = bindForgeAsDevice(vm, a.id, a.keys.id, ORIGIN, "matt");
    expect((await post("/gate/bind", { view: a.view, bind, cert, ssh: [sshSign(mattKey, forgeBindBytes(bind.body))] })).status).toBe(403);
  });

  it("an unbound account gets no session", async () => {
    const a = account();
    await expect(session(a.id, a.laptop, a.cert)).rejects.toThrow("isn't bound");
  });
});

describe("the account's devices", () => {
  it("go in as the user, with their token and cookie taken off", async () => {
    const a = await bound();
    const h = await session(a.id, a.laptop, a.cert);
    await call("/matt/anything/settings", { headers: { ...h, cookie: "i_like_gitea=x" } });
    expect(last()).toMatchObject({ path: "/matt/anything/settings", user: "matt", auth: null });
  });

  it("a session answers only its own nonce, once", async () => {
    const a = await bound();
    const { nonce } = (await (await call("/gate/challenge")).json()) as { nonce: string };
    const ans = answerForge(a.laptop, ORIGIN, nonce);
    expect((await post("/gate/session", { account: a.id, chain: { cert: a.cert }, answer: answerForge(newDevice(), ORIGIN, nonce) })).status).toBe(403);
    expect((await post("/gate/session", { account: a.id, chain: { cert: a.cert }, answer: ans })).status).toBe(201);
    expect((await post("/gate/session", { account: a.id, chain: { cert: a.cert }, answer: ans })).status).toBe(403);
  });
});

describe("without a session", () => {
  it("goes on as it came, never as a user the request names", async () => {
    await call("/explore/repos", { headers: { [HEADER]: "matt", authorization: "token forgejos-own" } });
    expect(last()).toMatchObject({ path: "/explore/repos", user: null, auth: "token forgejos-own" });
  });
});

describe("a grant", () => {
  async function vm(t: Partial<GrantTerms> = {}) {
    const a = await bound();
    const holder = newDevice();
    const g = grantForge(a.laptop, a.id, holder.id, terms(t));
    return { a, holder, g, h: await session(a.id, holder, a.cert, [g]) };
  }

  it("reaches its repos, at its levels", async () => {
    const { h } = await vm({ perms: { contents: "read", issues: "write" } });
    expect((await call("/api/v1/repos/matt/corkboard/contents/README.md", { headers: h })).status).toBe(200);
    expect(last().user).toBe("matt");
    expect((await call("/api/v1/repos/Matt/Corkboard/branches", { headers: h })).status).toBe(200);
    expect((await call("/api/v1/repos/matt/verse/contents/README.md", { headers: h })).status).toBe(403);
    expect((await call("/api/v1/repos/matt/corkboard/hooks", { headers: h })).status).toBe(403);
    expect((await post("/api/v1/repos/matt/corkboard/issues", { title: "x" }, h)).status).toBe(200);
    expect((await call("/api/v1/repos/matt/corkboard/contents/a.txt", { method: "PUT", body: "{}", headers: h })).status).toBe(403);
  });

  it("reaches nothing account-wide nor off the API and git", async () => {
    const { h } = await vm();
    for (const p of ["/api/v1/user", "/api/v1/repos/search", "/matt/corkboard/settings", "/api/v1/repos/matt/corkboard/actions/secrets", "/api/v1/repos/matt%2Fcorkboard/x/contents"]) {
      expect((await call(p, { headers: h })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await call("/api/v1/version", { headers: h })).status).toBe(200);
  });

  it("clones, and pushes only the refs it's given", async () => {
    const { h } = await vm();
    expect((await call("/matt/corkboard.git/info/refs?service=git-upload-pack", { headers: h })).status).toBe(200);
    expect((await call("/matt/corkboard.git/info/refs?service=git-receive-pack", { headers: h })).status).toBe(200);
    const ok = pushBody("refs/heads/agent/x");
    expect((await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: ok, headers: h })).status).toBe(200);
    expect(last().body).toBe(ok);
    const res = await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: pushBody("refs/heads/main"), headers: h });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toContain("refs/heads/main");
  });

  it("can't push with contents:read, and takes a gzipped push apart", async () => {
    const ro = await vm({ perms: { contents: "read" } });
    expect((await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: pushBody("refs/heads/agent/x"), headers: ro.h })).status).toBe(403);
    const { h } = await vm();
    const gz = Bun.gzipSync(new TextEncoder().encode(pushBody("refs/heads/main")));
    expect((await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: gz, headers: { ...h, "content-encoding": "gzip" } })).status).toBe(403);
  });

  it("writes contents only to its refs, the default branch when none is named", async () => {
    const { h } = await vm();
    expect((await call("/api/v1/repos/matt/corkboard/contents/a.txt", { method: "PUT", body: JSON.stringify({ content: "eA==" }), headers: h })).status).toBe(403);
    const body = JSON.stringify({ content: "eA==", branch: "main", new_branch: "agent/y" });
    expect((await call("/api/v1/repos/matt/corkboard/contents/a.txt", { method: "PUT", body, headers: h })).status).toBe(200);
    expect(last().body).toBe(body);
    expect((await call("/api/v1/repos/matt/corkboard/branches/main", { method: "DELETE", headers: h })).status).toBe(403);
  });

  it("needs pull_requests for a pull request's conversation, and its base for a merge", async () => {
    const { h } = await vm({ perms: { contents: "write", issues: "write" } });
    expect((await post("/api/v1/repos/matt/corkboard/issues/6/comments", { body: "hi" }, h)).status).toBe(200);
    expect((await post("/api/v1/repos/matt/corkboard/issues/5/comments", { body: "hi" }, h)).status).toBe(403);
    const pr = await vm({ perms: { contents: "write", pull_requests: "write" } });
    expect((await post("/api/v1/repos/matt/corkboard/issues/5/comments", { body: "hi" }, pr.h)).status).toBe(200);
    const merge = await post("/api/v1/repos/matt/corkboard/pulls/5/merge", { Do: "merge" }, pr.h);
    expect(merge.status).toBe(403);
    expect(((await merge.json()) as any).error).toContain("refs/heads/main");
    const free = await vm({ perms: { contents: "write", pull_requests: "write" }, refs: null });
    expect((await post("/api/v1/repos/matt/corkboard/pulls/5/merge", { Do: "merge" }, free.h)).status).toBe(200);
  });

  it("deletes the repository only with del", async () => {
    const plain = await vm({ perms: { administration: "write" } });
    expect((await call("/api/v1/repos/matt/corkboard", { method: "DELETE", headers: plain.h })).status).toBe(403);
    const del = await vm({ perms: { administration: "write" }, del: true });
    expect((await call("/api/v1/repos/matt/corkboard", { method: "DELETE", headers: del.h })).status).toBe(200);
  });

  it("is passed on narrower, and the sub-grant is held to it", async () => {
    const { a, holder, g } = await vm();
    const sub = newDevice();
    const g2 = grantForge(holder, a.id, sub.id, terms({ perms: { contents: "read" } }), g);
    const h = await session(a.id, sub, a.cert, [g, g2]);
    expect((await call("/matt/corkboard.git/info/refs?service=git-upload-pack", { headers: h })).status).toBe(200);
    expect((await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: pushBody("refs/heads/agent/x"), headers: h })).status).toBe(403);
    // The holder of the first can't answer for the second.
    await expect(session(a.id, holder, a.cert, [g, g2])).rejects.toThrow("holder");
  });

  it("works as Basic's password, for git", async () => {
    const { h } = await vm();
    const basic = `Basic ${btoa(`x:${h.authorization.slice(7)}`)}`;
    expect((await call("/matt/corkboard.git/info/refs?service=git-upload-pack", { headers: { authorization: basic } })).status).toBe(200);
    expect(last()).toMatchObject({ user: "matt", auth: null });
  });

  it("ends when it, a key in its chain, or the issuing device is revoked", async () => {
    const one = await vm();
    const hash = forgeGrantHash(one.g.body);
    // Someone else's word for it is taken and doesn't count.
    expect((await post("/gate/revoke", { account: one.a.id, grant: revokeForgeGrant(newDevice(), one.a.id, hash) })).status).toBe(200);
    await expect(session(one.a.id, one.holder, one.a.cert, [one.g])).resolves.toBeDefined();
    expect((await post("/gate/revoke", { account: one.a.id, grant: revokeForgeGrant(one.a.laptop, one.a.id, hash) })).status).toBe(200);
    expect((await call("/api/v1/repos/matt/corkboard", { headers: one.h })).status).toBe(401);
    await expect(session(one.a.id, one.holder, one.a.cert, [one.g])).rejects.toThrow("revoked");

    const two = await vm();
    expect((await post("/gate/revoke", { account: two.a.id, revocation: revoke(accountKeys(newRoot()), two.holder.id) })).status).toBe(400);
    expect((await post("/gate/revoke", { account: two.a.id, revocation: revoke(two.a.keys, two.holder.id) })).status).toBe(200);
    expect((await call("/api/v1/repos/matt/corkboard", { headers: two.h })).status).toBe(401);

    const three = await vm();
    expect((await post("/gate/revoke", { account: three.a.id, revocation: revoke(three.a.keys, three.a.laptop.id) })).status).toBe(200);
    expect((await call("/api/v1/repos/matt/corkboard", { headers: three.h })).status).toBe(401);
  });

  it("answers a page it lets in with CORS", async () => {
    const pre = await call("/matt/corkboard.git/git-upload-pack", { method: "OPTIONS", headers: { origin: "https://corkboard.test" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const { h } = await vm();
    const res = await call("/api/v1/repos/matt/corkboard", { headers: { ...h, origin: "https://corkboard.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://corkboard.test");
    const other = await call("/api/v1/repos/matt/corkboard", { headers: { ...h, origin: "https://evil.test" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the account's key moving on", () => {
  const rotation = (a: ReturnType<typeof account>, next = accountKeys(newRoot())) => {
    const r = signRotation(a.keys, { v: 1, account: a.id, from: a.keys.id, to: next.id, box: b64url(next.box.public), at: Date.now() });
    const view: AccountView = { ...a.view, key: next.id, box: b64url(next.box.public), proof: { ...a.view.proof, rotations: [r] } };
    return { next, view };
  };

  it("ends the old key's sessions and certs, and takes the new key's", async () => {
    const a = await bound();
    const h = await session(a.id, a.laptop, a.cert);
    const { next, view } = rotation(a);
    expect(await (await post("/gate/account", { view })).json()).toEqual({ account: a.id, key: next.id });
    expect((await call("/api/v1/repos/matt/corkboard", { headers: h })).status).toBe(401);
    await expect(session(a.id, a.laptop, a.cert)).rejects.toThrow();
    const cert = certify(next, a.laptop, "laptop");
    // The same view again changes nothing, and keeps the new key's sessions.
    const h2 = await session(a.id, a.laptop, cert);
    expect((await post("/gate/account", { view })).status).toBe(200);
    expect((await call("/api/v1/repos/matt/corkboard", { headers: h2 })).status).toBe(200);
  });

  it("can't be taken back by a view from before, nor moved by one that doesn't chain", async () => {
    const a = await bound();
    const { view } = rotation(a);
    expect((await post("/gate/account", { view })).status).toBe(200);
    expect((await post("/gate/account", { view: a.view })).status).toBe(409);
    const stranger = accountKeys(newRoot());
    const forged = signRotation(stranger, { v: 1, account: a.id, from: view.key, to: stranger.id, box: b64url(stranger.box.public), at: Date.now() });
    const bad: AccountView = { ...view, key: stranger.id, box: b64url(stranger.box.public), proof: { ...view.proof, rotations: [...view.proof.rotations, forged] } };
    expect((await post("/gate/account", { view: bad })).status).toBe(400);
    // Nor by binding again with the view from before.
    expect((await post("/gate/bind", { view: a.view, bind: bindForge(a.keys, a.id, ORIGIN, "matt"), forgejo_token: "good" })).status).toBe(409);
  });

  it("is news only for an account bound here", async () => {
    expect((await post("/gate/account", { view: account().view })).status).toBe(404);
    expect((await post("/gate/account", {})).status).toBe(404);
    expect((await call("/gate/account", { method: "POST", body: "not json" })).status).toBe(404);
  });
});

describe("the client's revocation", () => {
  const f = ((input: string | URL | Request, init?: RequestInit) => gate.fetch(new Request(input, init))) as typeof fetch;

  it("ends a grant at the gate, and a device", async () => {
    const a = await bound();
    const holder = newDevice();
    const g = grantForge(a.laptop, a.id, holder.id, terms());
    const h = await session(a.id, holder, a.cert, [g]);
    await sendRevocationToGate(ORIGIN, a.id, { grant: revokeForgeGrant(a.laptop, a.id, forgeGrantHash(g.body)) }, f);
    expect((await call("/api/v1/repos/matt/corkboard", { headers: h })).status).toBe(401);
    await expect(session(a.id, holder, a.cert, [g])).rejects.toThrow("revoked");

    const d = await session(a.id, a.laptop, a.cert);
    await sendRevocationToGate(ORIGIN, a.id, { revocation: revoke(a.keys, a.laptop.id) }, f);
    expect((await call("/api/v1/repos/matt/corkboard", { headers: d })).status).toBe(401);
    await expect(session(a.id, a.laptop, a.cert)).rejects.toThrow();
  });

  it("is nothing to a gate the account isn't bound at, and throws at any other refusal", async () => {
    const a = account();
    await sendRevocationToGate(ORIGIN, a.id, { revocation: revoke(a.keys, a.laptop.id) }, f);
    const b = await bound();
    await expect(sendRevocationToGate(ORIGIN, b.id, { revocation: revoke(accountKeys(newRoot()), b.laptop.id) }, f)).rejects.toThrow("forge gate /gate/revoke: revocation must be signed by the account's key");
    await expect(sendRevocationToGate(ORIGIN, b.id, {}, f)).rejects.toThrow("revocation or grant");
    const down = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    await expect(sendRevocationToGate(ORIGIN, b.id, { revocation: revoke(b.keys, b.laptop.id) }, down)).rejects.toThrow("forge gate /gate/revoke: 502");
    const unreachable = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    await expect(sendRevocationToGate(ORIGIN, b.id, { revocation: revoke(b.keys, b.laptop.id) }, unreachable)).rejects.toThrow("connection refused");
  });
});

describe("a grant's request, taken apart", () => {
  async function vm(t: Partial<GrantTerms> = {}) {
    const a = await bound();
    const holder = newDevice();
    return session(a.id, holder, a.cert, [grantForge(a.laptop, a.id, holder.id, terms(t))]);
  }

  it("isn't a path with an encoded slash or backslash, or an empty segment", async () => {
    const h = await vm();
    const before = seen.length;
    for (const p of ["/api/v1/repos/matt/corkboard//contents/a", "//matt/corkboard.git/info/refs?service=git-upload-pack", "/api/v1/repos/matt/corkboard/contents%2F..%2Fx", "/api/v1/repos/matt/corkboard/contents%5cx", "/api/v1/repos/matt%2fcorkboard/contents"]) {
      expect([p, (await call(p, { headers: h })).status]).toEqual([p, 400]);
    }
    expect(seen.length).toBe(before);
  });

  it("is taken with its dot segments resolved, as Forgejo takes it, so one reaches only what the path it resolves to does", async () => {
    const h = await vm();
    const before = seen.length;
    for (const p of ["/api/v1/repos/matt/corkboard/../other/contents/a", "/api/v1/repos/matt/corkboard/%2e%2e/other/contents/a", "/api/v1/repos/matt/corkboard/contents/../../../../user", "/matt/corkboard.git/../../other/r.git/info/refs?service=git-upload-pack"]) {
      expect([p, (await call(p, { headers: h })).status]).toEqual([p, 403]);
    }
    expect(seen.length).toBe(before);
    expect((await call("/api/v1/repos/matt/other/../corkboard/contents/a", { headers: h })).status).toBe(200);
    expect(last().path).toBe("/api/v1/repos/matt/corkboard/contents/a");
  });

  it("holds no more than 64 MiB of an API write to read its refs", async () => {
    const h = await vm();
    const before = seen.length;
    const big = new Uint8Array(64 * 1024 * 1024 + 1).fill(0x20);
    expect((await call("/api/v1/repos/matt/corkboard/contents/a.txt", { method: "PUT", body: big, headers: h })).status).toBe(413);
    expect(seen.length).toBe(before);
  });

  it("pushes a wiki to any ref, given wiki:write, and not the repository", async () => {
    const h = await vm({ perms: { wiki: "write" } });
    const main = pushBody("refs/heads/main");
    expect((await call("/matt/corkboard.wiki.git/git-receive-pack", { method: "POST", body: main, headers: h })).status).toBe(200);
    expect(last()).toMatchObject({ path: "/matt/corkboard.wiki.git/git-receive-pack", body: main, user: "matt" });
    expect((await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: pushBody("refs/heads/agent/x"), headers: h })).status).toBe(403);
    const ro = await vm({ perms: { wiki: "read" } });
    expect((await call("/matt/corkboard.wiki.git/git-receive-pack", { method: "POST", body: main, headers: ro })).status).toBe(403);
    expect((await call("/matt/corkboard.wiki.git/info/refs?service=git-upload-pack", { headers: ro })).status).toBe(200);
  });

  it("takes a push gzipped or as it is, and in no other encoding", async () => {
    const h = await vm();
    const ok = pushBody("refs/heads/agent/x");
    const br = await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: ok, headers: { ...h, "content-encoding": "br" } });
    expect(br.status).toBe(415);
    expect(((await br.json()) as any).error).toBe("content-encoding br");
    expect((await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: ok, headers: { ...h, "content-encoding": "identity" } })).status).toBe(200);
    expect(last().body).toBe(ok);
    // A gzipped one goes on unzipped.
    expect((await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: Bun.gzipSync(new TextEncoder().encode(ok)), headers: { ...h, "content-encoding": "gzip" } })).status).toBe(200);
    expect(last().body).toBe(ok);
    // One whose commands don't parse goes nowhere.
    expect((await call("/matt/corkboard.git/git-receive-pack", { method: "POST", body: "zzzz", headers: h })).status).toBe(400);
  });
});
