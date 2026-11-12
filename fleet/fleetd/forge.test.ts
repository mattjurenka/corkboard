// A spawn's git: the grant the node signs at its claim to the key fleetd
// made it, renewed as it runs, and fleetd's forge on the slot's gateway,
// which shows it for the guest.   bun test fleet/fleetd
import { afterAll, expect, test } from "bun:test";
import { certify, newDevice } from "../../lib/e2ee/device";
import { grantForge } from "../../lib/e2ee/forge";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import { forgeHandler } from "../../bridge/node/forge";
import { type Git, GitGrants, forgeOrigin, gitNote, newHolder, slotForge } from "./forge";
import type { Manifest, Spawn } from "./fleet";

const GATE = "https://git.test";
const forgejo = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/api/v1/user" ? Response.json({ login: "matt" }) : Response.json({ ok: true })) });
afterAll(() => forgejo.stop(true));

// The account, its node (a device), and a spawn's grant from the node.
function claimed(o: { holder?: string } = {}) {
  const keys = accountKeys(newRoot());
  const node = newDevice();
  const cert = certify(keys, node, "node");
  const h = newHolder();
  const g = grantForge(node, keys.id, o.holder ?? h.id, { name: "fleet s1 (coding)", repos: ["matt/corkboard"], perms: { contents: "write" }, refs: ["agent/*"], expires: Date.now() + 86_400_000 });
  const git: Git = { account: keys.id, gate: GATE, chain: { cert, grants: [g] }, key: h.key };
  const s: Spawn = { id: "s1", template: "coding", task: "t", by: "user", account: "personal", state: "running", slot: "agent-0", created: "", remote: { board: null, card: null, agent: "a", token: null, git } };
  return s;
}

const m = { slots: { "agent-0": { shareDir: "/nonexistent" } } } as unknown as Manifest;

// A node that gives another grant to the same key, or none while give is false.
function node() {
  const o = { give: true, asked: [] as string[], saved: [] as Spawn[] };
  const grants = new GitGrants(
    async (sp, h) => {
      o.asked.push(h);
      if (!o.give) throw new Error("node away");
      const ends = sp.remote!.git!.chain.grants!.at(-1)!.body.expires;
      const g = grantForge(newDevice(), sp.remote!.git!.account, h, { name: "again", repos: ["matt/corkboard"], perms: { contents: "write" }, expires: ends + 86_400_000 });
      return { account: sp.remote!.git!.account, gate: GATE, chain: { cert: sp.remote!.git!.chain.cert, grants: [g] } };
    },
    (sp) => o.saved.push(structuredClone(sp)),
  );
  return { o, grants };
}

test("a grant nearly over gets another from the node, kept with the spawn", async () => {
  const s = claimed();
  const ends = s.remote!.git!.chain.grants![0].body.expires;
  const key = s.remote!.git!.key;
  const holder = s.remote!.git!.chain.grants![0].body.holder;
  const { o, grants } = node();
  await grants.keep(s, ends - 5 * 3600_000);
  expect(o.asked).toEqual([]);
  await grants.keep(s, ends - 3600_000);
  expect(o.asked).toEqual([holder]);
  expect(o.saved[0].remote!.git!).toMatchObject({ key, chain: { grants: [{ body: { name: "again", holder, expires: ends + 86_400_000 } }] } });
  // The new one's far off: no more asking.
  await grants.keep(s, ends);
  expect(o.asked.length).toBe(1);
});

test("one the node won't give leaves the last in use and waits a minute to ask again; none for a spawn that's over", async () => {
  const s = claimed();
  const ends = s.remote!.git!.chain.grants![0].body.expires;
  const { o, grants } = node();
  o.give = false;
  await grants.step(m, [s], ends - 3600_000);
  await grants.step(m, [s], ends - 3600_000 + 30_000);
  expect(o.asked.length).toBe(1);
  expect(s.remote!.git!.chain.grants![0].body.expires).toBe(ends);
  await grants.step(m, [s], ends - 3600_000 + 61_000);
  expect(o.asked.length).toBe(2);
  o.give = true;
  await grants.step(m, [{ ...s, state: "done" }], ends - 3600_000 + 200_000);
  expect(o.asked.length).toBe(2);
});

test("a grant to another key isn't renewed", async () => {
  const s = claimed({ holder: newHolder().id });
  const { o, grants } = node();
  await grants.keep(s, s.remote!.git!.chain.grants![0].body.expires - 3600_000);
  expect(o.asked).toEqual([]);
});

test("the agent is told what it has", async () => {
  expect(gitNote(claimed())).toContain("http://fleet-gateway:8890/ (the forge's own URLs go there too) to matt/corkboard (contents:write; pushes only to refs/heads/agent/*)");
  expect(gitNote({ id: "x" } as Spawn)).toBe("");
});

test("a slot's guest reaches the forge through fleetd, which shows its spawn's grant", async () => {
  const keys = accountKeys(newRoot());
  const node = newDevice();
  const fleetd = newDevice();
  const fleetdCert = certify(keys, fleetd, "fleetd", Date.now(), "relay");
  const h = newHolder();
  const g = grantForge(node, keys.id, h.id, { name: "fleet s1 (coding)", repos: ["matt/corkboard"], perms: { contents: "read" }, expires: Date.now() + 86_400_000 });
  const git: Git = { account: keys.id, gate: GATE, chain: { cert: certify(keys, node, "node"), grants: [g] }, key: h.key };
  const s: Spawn = { id: "s1", template: "coding", task: "t", by: "user", account: "personal", state: "running", slot: "agent-0", created: "", remote: { board: null, card: null, agent: "a", token: null, git } };
  // The leader's forge, as fleetd's channel reaches it.
  const forge = forgeHandler({ upstream: forgejo.url.href, userHeader: "X-Forge-User", records: { user: () => "matt", revokedBy: () => [] }, account: () => ({ id: keys.id, key: keys.id }), revocations: async () => [] });
  let all = [s];
  const handle = slotForge({
    manifest: () => ({ slots: { "agent-0": { guestAddress: "10.80.0.2", hostAddress: "10.80.0.1" } } }) as unknown as Manifest,
    spawns: () => all,
    device: () => fleetd.id,
    send: (path, init) => forge(new Request(`http://node.invalid${path}`, init), fleetdCert),
  });
  const ask = (path: string, from = "10.80.0.2") => handle("agent-0", new Request(`http://10.80.0.1:8890${path}`), from);
  expect((await ask("/matt/corkboard.git/info/refs?service=git-upload-pack")).status).toBe(200);
  expect((await ask("/matt/corkboard.git/info/refs?service=git-upload-pack", "::ffff:10.80.0.2")).status).toBe(200);
  expect((await ask("/matt/corkboard.git/info/refs?service=git-receive-pack")).status).toBe(403);
  expect((await ask("/matt/secret.git/info/refs?service=git-upload-pack")).status).toBe(403);
  expect((await ask("/matt/corkboard.git/info/refs?service=git-upload-pack", "10.81.0.2")).status).toBe(403);
  expect((await handle("agent-1", new Request("http://10.80.0.1:8890/"), "10.80.0.2")).status).toBe(403);
  all = [{ ...s, state: "done" }];
  expect((await ask("/matt/corkboard.git/info/refs?service=git-upload-pack")).status).toBe(403);
});

test("a repo cloned from the forge is the guest's origin, on the spawn's branch", () => {
  const s = claimed();
  expect(forgeOrigin(s, "http://127.0.0.1:7777/forge/matt/corkboard.git\n")).toEqual({ repo: "matt/corkboard", branch: "agent/s1/work", url: "http://fleet-gateway:8890/matt/corkboard.git" });
  expect(forgeOrigin(s, "git@git.corkboard.fyi:matt/corkboard.git")?.repo).toBe("matt/corkboard");
  expect(forgeOrigin(s, "https://git.corkboard.fyi/matt/corkboard")?.repo).toBe("matt/corkboard");
  expect(forgeOrigin(s, "https://git.corkboard.fyi/matt/secret.git")).toBeUndefined();
  expect(forgeOrigin(s, "git@github.com:matt/corkboard.git")).toBeUndefined();
  expect(forgeOrigin({ ...s, remote: { ...s.remote!, git: undefined } }, "https://git.corkboard.fyi/matt/corkboard")).toBeUndefined();
  s.forge = forgeOrigin(s, "https://git.corkboard.fyi/matt/corkboard");
  expect(gitNote(s)).toContain("Your work dir's origin is matt/corkboard there, on branch agent/s1/work");
  expect(gitNote(s)).not.toContain("pull request");
});

test("one that may write pull requests is told how to open one", () => {
  const s = claimed();
  const keys = accountKeys(newRoot());
  const g = grantForge(newDevice(), keys.id, newHolder().id, { name: "fleet s1 (coding)", repos: ["matt/*"], perms: { contents: "write", pull_requests: "write" }, refs: ["agent/s1/*"], expires: Date.now() + 86_400_000 });
  s.remote!.git!.chain.grants = [g];
  expect(gitNote(s)).toContain("POST {\"head\", \"base\", \"title\", \"body\"} as JSON to http://fleet-gateway:8890/api/v1/repos/<owner>/<repo>/pulls");
  expect(forgeOrigin(s, "https://git.corkboard.fyi/matt/other.git")?.branch).toBe("agent/s1/work");
  expect(forgeOrigin({ ...s, id: "s2" }, "https://git.corkboard.fyi/matt/other.git")).toBeUndefined();
});
