// A spawn's git: the grant the node signs at its claim to the key fleetd
// made it, a session at the gate with it, and the token in its share,
// renewed as it runs.   bun test fleet/fleetd
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify, creation, newDevice } from "../../lib/e2ee/device";
import { bindForge, grantForge } from "../../lib/e2ee/forge";
import { openForgeSession } from "../../lib/e2ee/forge-client";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import { type AccountView, b64url } from "../../lib/e2ee/wire";
import { createGate } from "../../forge/gate/gate";
import { Store } from "../../forge/gate/store";
import { type Git, GitSessions, gitNote, newHolder } from "./forge";
import type { Manifest, Spawn } from "./fleet";

const GATE = "https://git.test";
const forgejo = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/api/v1/user" ? Response.json({ login: "matt" }) : Response.json({ ok: true })) });
const gate = createGate({ origin: GATE, upstream: forgejo.url.href, userHeader: "X-Forge-User", corsOrigins: [], store: new Store(":memory:") });
const viaGate = ((u: string | URL, i?: RequestInit) => gate.fetch(new Request(u, i))) as typeof fetch;
const dir = mkdtempSync(join(tmpdir(), "fleet-forge-"));
afterAll(() => (forgejo.stop(true), rmSync(dir, { recursive: true, force: true })));

// The account, its node (a device), bound at the gate, and a spawn's grant from the node.
async function claimed(o: { holder?: string } = {}) {
  const keys = accountKeys(newRoot());
  const node = newDevice();
  const cert = certify(keys, node, "node");
  const view: AccountView = { id: keys.id, key: keys.id, box: b64url(keys.box.public), proof: { creation: creation(keys, "https://relay.test", null), rotations: [] } };
  const bound = await gate.fetch(new Request(`${GATE}/gate/bind`, { method: "POST", body: JSON.stringify({ view, bind: bindForge(keys, keys.id, GATE, "matt"), forgejo_token: "t" }) }));
  expect(bound.status).toBe(201);
  const h = newHolder();
  const g = grantForge(node, keys.id, o.holder ?? h.id, { name: "fleet s1 (coding)", repos: ["matt/corkboard"], perms: { contents: "write" }, refs: ["agent/*"], expires: Date.now() + 86_400_000 });
  const git: Git = { account: keys.id, gate: GATE, chain: { cert, grants: [g] }, key: h.key };
  const s: Spawn = { id: "s1", template: "coding", task: "t", by: "user", account: "personal", state: "running", slot: "agent-0", created: "", remote: { board: null, card: null, agent: "a", token: null, git } };
  return s;
}

const m = { slots: { "agent-0": { shareDir: dir } } } as unknown as Manifest;

test("a running spawn's share gets a session's token, which the gate takes as the account's user", async () => {
  const s = await claimed();
  await new GitSessions((g, a, h, c) => openForgeSession(g, a, h, c, viaGate)).step(m, [s]);
  const token = readFileSync(join(dir, "git-token"), "utf8").trim();
  expect(token).toStartWith("cbg_");
  const res = await gate.fetch(new Request(`${GATE}/gate/session`, { headers: { authorization: `Basic ${btoa(`fleet:${token}`)}` } }));
  expect(await res.json()).toMatchObject({ user: "matt", scope: { repos: ["matt/corkboard"], perms: { contents: "write" } } });
});

test("a new one only when the last is nearly over, and none for a spawn that's over", async () => {
  const s = await claimed();
  let opened = 0;
  const now = Date.now();
  const sessions = new GitSessions(async () => ({ token: `cbg_${++opened}`, expires: now + 3600_000, user: "matt", scope: null }));
  await sessions.step(m, [s], now);
  await sessions.step(m, [s], now + 30 * 60_000);
  expect(opened).toBe(1);
  await sessions.step(m, [s], now + 55 * 60_000);
  expect(opened).toBe(2);
  expect(readFileSync(join(dir, "git-token"), "utf8")).toBe("cbg_2\n");
  await sessions.step(m, [{ ...s, state: "done" }], now + 2 * 3600_000);
  expect(opened).toBe(2);
});

test("a grant to another key isn't used, and a failure waits a minute to try again", async () => {
  const s = await claimed({ holder: newHolder().id });
  let opened = 0;
  const sessions = new GitSessions(async () => (opened++, { token: "cbg_x", expires: 0, user: "", scope: null }));
  const now = Date.now();
  await sessions.keep(dir, s, now);
  await sessions.keep(dir, s, now + 1000);
  expect(opened).toBe(0);
  let fails = 0;
  const flaky = new GitSessions(async () => {
    fails++;
    throw new Error("gate down");
  });
  const good = await claimed();
  await flaky.keep(dir, good, now);
  await flaky.keep(dir, good, now + 30_000);
  await flaky.keep(dir, good, now + 61_000);
  expect(fails).toBe(2);
});

test("a grant nearly over gets another from the node, kept with the spawn; one the node won't give leaves the last in use", async () => {
  const s = await claimed();
  const ends = s.remote!.git!.chain.grants![0].body.expires;
  const key = s.remote!.git!.key;
  const holder = s.remote!.git!.chain.grants![0].body.holder;
  const opened: number[] = [];
  const asked: string[] = [];
  const saved: Spawn[] = [];
  let give = true;
  const sessions = new GitSessions(
    async (_g, _a, _h, c) => (opened.push(c.grants![0].body.expires), { token: "cbg_r", expires: Math.min(Date.now() + 86_400_000, c.grants![0].body.expires), user: "matt", scope: null }),
    async (sp, h) => {
      asked.push(h);
      if (!give) throw new Error("node away");
      const g = grantForge(newDevice(), sp.remote!.git!.account, h, { name: "again", repos: ["matt/corkboard"], perms: { contents: "write" }, expires: ends + 86_400_000 });
      return { account: sp.remote!.git!.account, gate: GATE, chain: { cert: sp.remote!.git!.chain.cert, grants: [g] } };
    },
    (sp) => saved.push(structuredClone(sp)),
  );
  await sessions.keep(dir, s, ends - 5 * 3600_000);
  expect(asked).toEqual([]);
  await sessions.keep(dir, s, ends - 3600_000);
  expect(asked).toEqual([holder]);
  expect(opened.at(-1)).toBe(ends + 86_400_000);
  expect(saved[0].remote!.git!).toMatchObject({ key, chain: { grants: [{ body: { name: "again", holder } }] } });
  // The node away: the old grant's sessions go on.
  const t = { ...(await claimed()), id: "s2" };
  give = false;
  const before = opened.length;
  await sessions.keep(dir, t, t.remote!.git!.chain.grants![0].body.expires - 3600_000);
  expect(opened.length).toBe(before + 1);
});

test("the agent is told what it has", async () => {
  expect(gitNote(await claimed())).toContain("https://git.test/ to matt/corkboard (contents:write; pushes only to refs/heads/agent/*)");
  expect(gitNote({ id: "x" } as Spawn)).toBe("");
});
